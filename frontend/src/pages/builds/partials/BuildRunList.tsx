import { EmptyState } from "@flightroom/design-system"
import { useTranslation } from "react-i18next"
import AskAssistantButton from "@/components/assistant/AskAssistantButton"
import { BuildRun, BuildStatus } from "@/hooks/apiClients/useBuildsApi"
import { CodeRepositoryProvider } from "@/hooks/apiClients/useCodeRepositoriesApi"
import BuildStatusBadge from "./BuildStatusBadge"
import ProviderRunLink from "./ProviderRunLink"

export enum BuildComponentKind {
    FRONTEND = "FRONTEND",
    BACKEND = "BACKEND"
}

interface BuildRunListProps {
    runs: BuildRun[]
    kind: BuildComponentKind
    /** Id of the frontend for a frontend build, of the backend for a backend one. */
    componentId: string
    componentName: string
    provider?: CodeRepositoryProvider
}

const formatMoment = (value?: string) => (value ? new Date(value).toLocaleString() : "—")

/**
 * The recent runs of a single frontend or backend, newest first, as shown in the
 * row the user expanded.
 */
const BuildRunList: React.FC<BuildRunListProps> = ({ runs, kind, componentId, componentName, provider }) => {
    const { t } = useTranslation()

    if (runs.length === 0) {
        return <EmptyState size="sm" description={t("builds.table.no_runs")} />
    }

    const explainQuestion = (run: BuildRun) =>
        kind === BuildComponentKind.BACKEND
            ? t("assistant.questions.explain_backend_build", { name: componentName, backendId: componentId, runId: run.id, ref: run.ref || "—" })
            : t("assistant.questions.explain_build", { name: componentName, frontendId: componentId, runId: run.id, ref: run.ref || "—" })

    return (
        <ul className="flex flex-col gap-2">
            {runs.map(run => (
                <li key={run.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                    <BuildStatusBadge status={run.status} />
                    {run.ref && <span className="font-mono">{run.ref}</span>}
                    {run.name && <span className="text-foreground-secondary">{run.name}</span>}
                    <span className="text-foreground-secondary">{formatMoment(run.startedAt)}</span>
                    {run.triggeredBy && <span className="text-foreground-secondary">{t("builds.table.triggered_by", { user: run.triggeredBy })}</span>}
                    {run.url && <ProviderRunLink url={run.url} provider={provider} />}
                    {run.status === BuildStatus.FAILED && (
                        <AskAssistantButton size="sm" variant="ghost" label={t("assistant.actions.explain_build")} question={explainQuestion(run)} dataTestId={`assistant-explain-build-${run.id}`} />
                    )}
                </li>
            ))}
        </ul>
    )
}

export default BuildRunList
