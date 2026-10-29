import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import useAssistantStore from "@/store/useAssistantStore"

/** What the panel needs of the Web Speech API recognition: lib.dom does not declare it yet. */
interface SpeechRecognitionLike {
    lang: string
    continuous: boolean
    interimResults: boolean
    onresult: ((event: { results: SpeechRecognitionResultList }) => void) | null
    onerror: ((event: { error: string }) => void) | null
    onend: (() => void) | null
    start: () => void
    abort: () => void
}

type SpeechRecognitionClass = new () => SpeechRecognitionLike

/** Chrome, Edge and Safari have it, Safari and older Chrome under the webkit prefix; Firefox does not. */
const recognitionClass = (): SpeechRecognitionClass | undefined => {
    if (typeof window === "undefined") return undefined
    const speechWindow = window as unknown as { SpeechRecognition?: SpeechRecognitionClass; webkitSpeechRecognition?: SpeechRecognitionClass }
    return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition
}

/** Recognition errors the user can act on, as keys under `assistant.voice.errors`; anything else is `generic`. */
const ERROR_KEYS: Record<string, string> = {
    "not-allowed": "not_allowed",
    "service-not-allowed": "not_allowed",
    "audio-capture": "audio_capture",
    network: "network"
}

/**
 * The answer as it reads aloud, one sentence per utterance: Chrome cuts a long utterance short.
 * Code blocks are skipped, links read as their text, the markdown marks dropped.
 */
export const toSpokenSentences = (markdown: string): string[] =>
    markdown
        .split("```")
        .filter((_, index) => index % 2 === 0)
        .join("\n")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*#>`~]/g, "")
        .replace(/[_|]/g, " ")
        .split(/(?<=[.!?])\s+|\n+/)
        .map(sentence => sentence.replace(/\s+/g, " ").trim())
        .filter(sentence => /[\p{L}\p{N}]/u.test(sentence))

export type VoicePhase = "idle" | "listening" | "speaking"

interface VoiceModeOptions {
    /** False while an answer streams or waits for a confirmation: the microphone waits too. */
    canListen: boolean
    /** The last answer, once it is over: read aloud once, then the microphone opens again. */
    answer?: { id: string; text: string }
    /** What the user is saying, while they say it. */
    onInterim: (text: string) => void
    /** What the user said, once they stopped talking. */
    onFinal: (text: string) => void
}

/**
 * The voice mode of the assistant: the microphone listens, what the user says is sent when they
 * stop talking, the answer is read aloud, and the microphone opens again, until the user leaves.
 * Recognition and speech are the browser's own (Web Speech API): nothing goes through the server.
 */
const useVoiceMode = ({ canListen, answer, onInterim, onFinal }: VoiceModeOptions) => {
    const { i18n } = useTranslation()
    // In the store: the questions read it, to ask for answers made to be heard.
    const active = useAssistantStore(state => state.voiceMode)
    const setActive = useAssistantStore(state => state.setVoiceMode)
    const [phase, setPhase] = useState<VoicePhase>("idle")
    const [errorKey, setErrorKey] = useState<string>()
    const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
    // The answer already read, or already there when the voice mode started: it is not read (again).
    const spokenRef = useRef<string | undefined>(undefined)
    const callbacksRef = useRef({ onInterim, onFinal })
    callbacksRef.current = { onInterim, onFinal }

    const supported = Boolean(recognitionClass())

    const stop = () => {
        setActive(false)
        setPhase("idle")
        const recognition = recognitionRef.current
        recognitionRef.current = null
        recognition?.abort()
        window.speechSynthesis?.cancel()
    }

    const start = () => {
        spokenRef.current = answer?.id
        setErrorKey(undefined)
        setActive(true)
    }

    // biome-ignore lint/correctness/useExhaustiveDependencies: the phase moving back to idle is what opens the next turn; answer is compared by id.
    useEffect(() => {
        if (!active || phase !== "idle") return

        if (answer && answer.id !== spokenRef.current) {
            spokenRef.current = answer.id
            const sentences = toSpokenSentences(answer.text)
            if (sentences.length > 0 && window.speechSynthesis) {
                setPhase("speaking")
                sentences.forEach((sentence, index) => {
                    const utterance = new SpeechSynthesisUtterance(sentence)
                    utterance.lang = i18n.language
                    if (index === sentences.length - 1) utterance.onend = () => setPhase("idle")
                    // A voice that fails drops the rest of the answer: the microphone opens again.
                    utterance.onerror = () => {
                        window.speechSynthesis.cancel()
                        setPhase("idle")
                    }
                    window.speechSynthesis.speak(utterance)
                })
                return
            }
        }

        const Recognition = recognitionClass()
        if (!canListen || !Recognition) return

        const recognition = new Recognition()
        recognition.lang = i18n.language
        recognition.continuous = false
        recognition.interimResults = true
        let transcript = ""
        let failed = false
        recognition.onresult = event => {
            transcript = Array.from(event.results, result => result[0]?.transcript ?? "").join("")
            callbacksRef.current.onInterim(transcript)
        }
        recognition.onerror = event => {
            // Silence ends the turn without a question: the microphone just opens again.
            if (event.error === "no-speech" || event.error === "aborted") return
            failed = true
            setErrorKey(ERROR_KEYS[event.error] ?? "generic")
        }
        recognition.onend = () => {
            // Aborted by stop(), or replaced: nothing left to do.
            if (recognitionRef.current !== recognition) return
            recognitionRef.current = null
            if (failed) {
                setActive(false)
                setPhase("idle")
                return
            }
            if (transcript.trim()) callbacksRef.current.onFinal(transcript)
            setPhase("idle")
        }
        recognitionRef.current = recognition
        setPhase("listening")
        recognition.start()
    }, [active, phase, canListen, answer?.id])

    // A question sent another way (typed, a suggestion) closes the microphone: the answer is read when it is over.
    useEffect(() => {
        if (canListen || phase !== "listening") return
        const recognition = recognitionRef.current
        recognitionRef.current = null
        recognition?.abort()
        setPhase("idle")
    }, [canListen, phase])

    // Closing the panel or leaving the page silences it, and ends it: the store outlives the panel.
    // biome-ignore lint/correctness/useExhaustiveDependencies: on unmount only; setActive is a stable store action.
    useEffect(
        () => () => {
            const recognition = recognitionRef.current
            recognitionRef.current = null
            recognition?.abort()
            window.speechSynthesis?.cancel()
            setActive(false)
        },
        []
    )

    return { supported, active, phase, errorKey, start, stop }
}

export default useVoiceMode
