import { useIsMutating, useMutationState, useQuery } from "@tanstack/react-query"
import { X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import Mascot from "@/components/mascot/Mascot"
import useArgoCdApi, { type Rollout } from "@/hooks/apiClients/useArgoCdApi"
import { DEPLOY_MUTATION_KEY, type DeploymentDTO } from "@/hooks/apiClients/useDeploymentsApi"
import useElapsed from "@/hooks/useElapsed"
import useProjectStore from "@/store/useProjectStore"
import DeployGame from "./DeployGame"
import RolloutApplications from "./RolloutApplications"

const MESSAGE_INTERVAL = 6000

/** How often the rollout is read again while the containers start */
const ROLLOUT_POLL_MS = 5000

/** As the build and deploy of a domain: past this the overlay stops waiting, and says what does not run yet */
const ROLLOUT_TIMEOUT_MS = 20 * 60 * 1000

/** As the build and deploy of a domain: an application broken this long is taken for broken, a restarting pod may recover */
const DEGRADED_GRACE_MS = 2 * 60 * 1000

/**
 * committing: the deploy request runs, the console commits to the repositories. rolling_out: committed, Argo CD
 * applies it and the pods start. The other three are the end: every container runs the new version, Argo CD
 * could not apply it, or the containers were not ready in time.
 */
type Phase = "committing" | "rolling_out" | "done" | "failed" | "timeout"

const ENDED: Phase[] = ["done", "failed", "timeout"]

/** Those the deploy changed: the others are only applied again. A deploy that changed no version, of config maps only, shows them all */
const shownApplications = (rollout?: Rollout) => {
    const updated = rollout?.applications.filter(application => application.updated) ?? []
    return updated.length > 0 ? updated : (rollout?.applications ?? [])
}

/** The deploy the overlay follows once committed, the domain it was of, and when the overlay began to follow it */
interface Followed {
    projectId: string
    deploymentId: string
    domainId?: string
    at: number
}

/** The deploy that ran last, as its mutation left it */
const useLastDeploy = () => {
    const deploys = useMutationState({
        filters: { mutationKey: DEPLOY_MUTATION_KEY },
        select: mutation => ({
            status: mutation.state.status,
            submittedAt: mutation.state.submittedAt,
            // A redeploy answers one deployment, a deploy one per environment
            deployment: (Array.isArray(mutation.state.data) ? mutation.state.data[0] : mutation.state.data) as DeploymentDTO | undefined,
            domainId: mutation.options.meta?.domainId as string | undefined,
            // A redeploy serves an older deployment again and commits nothing: there is no rollout to follow
            followRollout: mutation.options.meta?.followRollout === true
        })
    })
    return deploys[deploys.length - 1]
}

interface DeployScreenProps {
    phase: Phase
    startedAt: number
    endedAt?: number
    rollout?: Rollout
    readError: boolean
    onHide: () => void
    onClose: () => void
}

const DeployScreen: React.FC<DeployScreenProps> = ({ phase, startedAt, endedAt, rollout, readError, onHide, onClose }) => {
    const { t } = useTranslation()
    const elapsed = useElapsed(startedAt, endedAt)
    const messages = t("deployments.overlay.messages", { returnObjects: true }) as string[]
    const [messageIndex, setMessageIndex] = useState(() => Math.floor(Math.random() * messages.length))
    const ended = ENDED.includes(phase)
    const applications = shownApplications(rollout)

    useEffect(() => {
        const interval = setInterval(() => setMessageIndex(index => index + 1), MESSAGE_INTERVAL)
        return () => clearInterval(interval)
    }, [])

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return
            event.stopPropagation()
            if (ended) onClose()
            else onHide()
        }
        window.addEventListener("keydown", onKeyDown, true)
        return () => window.removeEventListener("keydown", onKeyDown, true)
    }, [ended, onHide, onClose])

    const title = {
        committing: t("deployments.overlay.title"),
        rolling_out: t("deployments.overlay.rollout_title"),
        done: t("deployments.overlay.done_title"),
        failed: t("deployments.overlay.failed_title"),
        timeout: t("deployments.overlay.timeout_title")
    }[phase]
    const description = {
        committing: t("deployments.overlay.committing_description"),
        rolling_out: t("deployments.overlay.rollout_description"),
        done: t("deployments.overlay.done_description"),
        failed: t("deployments.overlay.failed_description"),
        timeout: t("deployments.overlay.timeout_description", { minutes: ROLLOUT_TIMEOUT_MS / 60_000 })
    }[phase]

    return (
        // pointer-events-auto: a modal dialog of Radix underneath turns them off on the body
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="deploy-overlay-title"
            className="pointer-events-auto fixed inset-0 z-[60] flex flex-col items-center justify-center-safe gap-6 overflow-y-auto bg-background/95 p-4 backdrop-blur-sm"
            data-testid={`deploy-overlay-${phase}`}
        >
            <div className="flex flex-col items-center gap-2 text-center">
                <Mascot mood={phase === "done" ? "idle" : ended ? "analyzing" : "deploying"} className="size-28" />
                <h2 id="deploy-overlay-title" className="text-2xl font-semibold">
                    {title}
                </h2>
                <p className="text-sm font-medium tabular-nums text-foreground-secondary">{t("deployments.overlay.elapsed", { time: elapsed })}</p>
                <p className="max-w-xl text-sm text-foreground-secondary">{description}</p>
                {!ended && (
                    <p className="min-h-6 text-foreground-secondary" aria-live="polite">
                        {messages[messageIndex % messages.length]}
                    </p>
                )}
            </div>
            {rollout?.tracked && (
                // Scrolls on its own: the game below stays in sight however many applications the deploy ships
                <div className="max-h-[30vh] w-full max-w-2xl shrink-0 overflow-y-auto" aria-live="polite">
                    <RolloutApplications applications={applications} />
                </div>
            )}
            {readError && !ended && <p className="text-xs text-foreground-secondary">{t("deployments.overlay.read_error")}</p>}
            {!ended && (
                <div className="w-full max-w-3xl">
                    <DeployGame />
                </div>
            )}
            <div className="flex flex-col items-center gap-2">
                {ended ? (
                    <Button onClick={onClose} dataTestId="deploy-overlay-close">
                        {t("deployments.overlay.close")}
                    </Button>
                ) : (
                    <>
                        <Button variant="secondary" onClick={onHide} dataTestId="deploy-overlay-hide">
                            {t("deployments.overlay.hide")}
                        </Button>
                        <p className="text-xs text-foreground-secondary">{t("deployments.overlay.hide_hint")}</p>
                    </>
                )}
            </div>
        </div>
    )
}

const DeployPill: React.FC<{ phase: Phase; startedAt: number; endedAt?: number; onShow: () => void; onClose: () => void }> = ({ phase, startedAt, endedAt, onShow, onClose }) => {
    const { t } = useTranslation()
    const elapsed = useElapsed(startedAt, endedAt)
    const ended = ENDED.includes(phase)
    const label = {
        committing: t("deployments.overlay.pill", { time: elapsed }),
        rolling_out: t("deployments.overlay.pill_rollout", { time: elapsed }),
        done: t("deployments.overlay.pill_done"),
        failed: t("deployments.overlay.pill_failed"),
        timeout: t("deployments.overlay.pill_timeout")
    }[phase]

    return (
        <div role="status" className="pointer-events-auto fixed bottom-4 right-4 z-[60] flex items-center gap-3 rounded-full border border-border bg-background py-2 pl-4 pr-2 shadow-lg">
            <Mascot mood={phase === "done" ? "idle" : ended ? "analyzing" : "deploying"} className="size-7" />
            <span className="text-sm tabular-nums">{label}</span>
            <Button variant="secondary" size="sm" onClick={onShow} dataTestId="deploy-overlay-show">
                {t("deployments.overlay.show")}
            </Button>
            {ended && (
                <Button variant="secondary" size="sm" onClick={onClose} aria-label={t("deployments.overlay.close")} dataTestId="deploy-overlay-pill-close">
                    <X />
                </Button>
            )}
        </div>
    )
}

/**
 * While a deploy runs the whole screen goes to a game and a timer: with GitOps a deploy can take long minutes.
 * The request ends once the console has committed; where Argo CD deploys, the screen then follows the rollout
 * until every container runs the new version, Argo CD fails to apply it, or the time is up. The deploy goes on
 * when the screen is hidden, and the next deploy shows it again.
 */
export const DeployOverlay: React.FC = () => {
    const isDeploying = useIsMutating({ mutationKey: DEPLOY_MUTATION_KEY }) > 0
    const last = useLastDeploy()
    const projectId = useProjectStore(state => state.project?._id)
    const { getRollout } = useArgoCdApi()
    const [startedAt, setStartedAt] = useState<number | null>(null)
    const [hidden, setHidden] = useState(false)
    const [followed, setFollowed] = useState<Followed | null>(null)
    const [timedOut, setTimedOut] = useState(false)
    const [endedAt, setEndedAt] = useState<number | undefined>()
    /** The deploy already handed to the rollout: the mutation state is read again at every render */
    const handled = useRef<number | undefined>(undefined)
    /** Since when each application is broken, as the overlay saw it: kept until it runs again, a crash loop goes back to progressing */
    const degradedSince = useRef(new Map<string, number>())
    const [now, setNow] = useState(Date.now)

    useEffect(() => {
        if (!isDeploying) return
        setStartedAt(Date.now())
        setHidden(false)
        setFollowed(null)
        setTimedOut(false)
        setEndedAt(undefined)
        degradedSince.current.clear()
    }, [isDeploying])

    const close = () => {
        setFollowed(null)
        setStartedAt(null)
    }

    // The request is over: a failed one is told by its toast, a committed one is followed until its containers run
    const lastStatus = last?.status
    const lastSubmittedAt = last?.submittedAt
    const deployment = last?.deployment
    const domainId = last?.domainId
    const followRollout = last?.followRollout
    useEffect(() => {
        if (isDeploying || !lastSubmittedAt || handled.current === lastSubmittedAt || (lastStatus !== "success" && lastStatus !== "error")) return
        handled.current = lastSubmittedAt
        // A deploy this overlay did not see start, one of before it was mounted, is not followed
        if (startedAt !== null && lastStatus === "success" && followRollout && projectId && deployment?._id) {
            setFollowed({ projectId, deploymentId: deployment._id, domainId, at: Date.now() })
        } else {
            setStartedAt(null)
        }
    }, [isDeploying, lastStatus, lastSubmittedAt, deployment, domainId, followRollout, projectId, startedAt])

    const rolloutQuery = useQuery({
        queryKey: ["deploy-rollout", followed],
        queryFn: () => getRollout(followed!.projectId, followed!.deploymentId, followed!.domainId),
        enabled: Boolean(followed) && !timedOut,
        refetchInterval: query => (query.state.data && (!query.state.data.tracked || query.state.data.done || query.state.data.failed) ? false : ROLLOUT_POLL_MS)
    })
    const rollout = followed ? rolloutQuery.data : undefined

    // Without Argo CD the deploy is over with its commit: nothing to follow
    useEffect(() => {
        if (rollout?.tracked === false) {
            setFollowed(null)
            setStartedAt(null)
        }
    }, [rollout?.tracked])

    // Counted from the commit, as the release counts: the request may have waited on the lock of the repository
    useEffect(() => {
        if (!followed) return
        const timer = setTimeout(() => setTimedOut(true), Math.max(0, followed.at + ROLLOUT_TIMEOUT_MS - Date.now()))
        const clock = setInterval(() => setNow(Date.now()), ROLLOUT_POLL_MS)
        return () => {
            clearTimeout(timer)
            clearInterval(clock)
        }
    }, [followed])

    // Only those shown, as the end of the rollout counts them: one the deploy did not touch does not fail it
    useEffect(() => {
        for (const application of shownApplications(rollout)) {
            if (application.state === "healthy") degradedSince.current.delete(application._id)
            else if (application.state === "degraded" && !degradedSince.current.has(application._id)) degradedSince.current.set(application._id, Date.now())
        }
    }, [rollout])
    const broken = [...degradedSince.current.values()].some(at => now - at > DEGRADED_GRACE_MS)

    // Until Argo CD first answers, the screen stays on the commit: a project without it never shows a rollout
    const phase: Phase =
        isDeploying || !followed || (!rollout && !rolloutQuery.isError) ? "committing" : rollout?.failed || broken ? "failed" : rollout?.done ? "done" : timedOut ? "timeout" : "rolling_out"
    const ended = ENDED.includes(phase)

    useEffect(() => {
        if (ended) setEndedAt(at => at ?? Date.now())
    }, [ended])

    // Shown from the start of the request until closed: the end of the request does not unmount the game
    if (startedAt === null) return null

    return createPortal(
        hidden ? (
            <DeployPill phase={phase} startedAt={startedAt} endedAt={endedAt} onShow={() => setHidden(false)} onClose={close} />
        ) : (
            <DeployScreen phase={phase} startedAt={startedAt} endedAt={endedAt} rollout={rollout} readError={rolloutQuery.isError} onHide={() => setHidden(true)} onClose={close} />
        ),
        document.body
    )
}

export default DeployOverlay
