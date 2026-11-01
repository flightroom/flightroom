import { redactSecrets } from "../../utils/redactSecrets"

// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape sequences of terminal colours are what is removed
const TERMINAL_ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]/g

/** A line drawn again in place, as a progress bar does with `\r`: only what it shows last. */
const lastDrawn = (line: string) => {
    const drawn = line.endsWith("\r") ? line.slice(0, -1) : line
    return drawn.slice(drawn.lastIndexOf("\r") + 1)
}

/**
 * The end of what a command printed, as the agent reads it and the job shows it: no colours, no frame of a progress bar
 * but the last, a credential masked. Masked whole, then cut: a private key or a token across the cut would be masked
 * by neither of its halves. The line the cut falls in is left out, as it may be the end of a secret whose start is gone.
 */
export const maskedEnd = (output: string, maxChars: number, alreadyCut = false) => {
    const masked = redactSecrets(output.replace(TERMINAL_ESCAPES, "").split("\n").map(lastDrawn).join("\n")).trimEnd()
    let text = masked.length > maxChars ? masked.slice(-maxChars) : masked
    const cut = alreadyCut || text.length < masked.length
    const firstLineEnd = text.indexOf("\n")
    if (cut && firstLineEnd !== -1) text = text.slice(firstLineEnd + 1)
    return { text, cut }
}
