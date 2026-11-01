import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Checkbox,
    Label,
    LogViewer,
    LogViewerActions,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue
} from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { AxiosError } from "axios"
import { ScrollText } from "lucide-react"
import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { followedLogQuery, useLogViewerLabels } from "@/components/application-logs/logViewerShared"
import useArgoCdApi from "@/hooks/apiClients/useArgoCdApi"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import { GitOpsErrorDetails, useGitOpsErrorTranslation } from "@/hooks/apiClients/useGitOpsErrorMessage"
import { errorCodeOf } from "@/hooks/useApiClient"
import useProjectStore, { useIsProjectViewer } from "@/store/useProjectStore"

const TAIL_OPTIONS = [100, 500, 1000, 5000]
/** While following, the pods, which come and go with a rollout, are read again less often than the logs */
const PODS_INTERVAL_MS = 15_000
/** The refusals of the logs themselves; those of Argo CD translate as on the settings screen */
const LOGS_ERROR_KEYS: Record<string, string> = {
    ARGOCD_NOT_CONFIGURED: "applicationLogs.errors.not_configured",
    ARGOCD_LOGS_FORBIDDEN: "applicationLogs.errors.forbidden",
    ARGOCD_LOGS_INVALID: "applicationLogs.errors.invalid"
}

/** A backend, Docker frontend or maintenance agent the logs can be read of */
export interface LogsApplication {
    slug: string
    name: string
}

type ApplicationLogsSectionProps = {
    /**
     * The environments of the project, from the page: a query of its own here would refetch them on mount,
     * and the page's ApiStatusHandler, which unmounts its children while they refetch, would loop on the spinner.
     */
    environments: EnvironmentDTO[]
} & (
    | {
          /** The slug of the backend, Docker frontend or maintenance agent: the Helm release, and its Application in every environment */
          slug: string
          applications?: never
      }
    | {
          /** Several of them, as on the overview of a domain: the card reads one at a time, picked first */
          applications: LogsApplication[]
          slug?: never
      }
)

/**
 * The last lines the pods of an application wrote, per environment, read through the Argo CD the project deploys
 * with: no access to the cluster is needed. Only the pods alive now, and the container before their last restart.
 * Not shown to a viewer, as logs may hold what the configuration hides.
 */
const ApplicationLogsSection: React.FC<ApplicationLogsSectionProps> = ({ slug: fixedSlug, applications, environments }) => {
    const { t } = useTranslation()
    const labels = useLogViewerLabels()
    const id = useId()
    const projectId = useProjectStore(state => state.project?._id)
    const isViewer = useIsProjectViewer()
    const argoCdApi = useArgoCdApi()
    const translateError = useGitOpsErrorTranslation()
    const statusQuery = useQuery({ queryKey: ["argocd", projectId], queryFn: () => argoCdApi.getArgoCd(projectId!), enabled: !!projectId && !isViewer })

    const [applicationSlug, setApplicationSlug] = useState<string>()
    const [environmentId, setEnvironmentId] = useState<string>()
    const [pod, setPod] = useState<string>()
    const [tailLines, setTailLines] = useState(500)
    const [previous, setPrevious] = useState(false)
    // The viewer waits for the typing to stop before it hands the filter over to Argo CD
    const [filter, setFilter] = useState("")
    const [follow, setFollow] = useState(false)

    // The first environment in the project's order, unless one was picked
    const selectedEnvironment = environments.some(environment => environment._id === environmentId) ? environmentId : environments[0]?._id
    // The application picked among several, else the first
    const pickedSlug = applications?.some(application => application.slug === applicationSlug) ? applicationSlug : applications?.[0]?.slug
    const slug = fixedSlug ?? pickedSlug
    const ready = Boolean(projectId && statusQuery.data?.initializedAt && selectedEnvironment && slug)

    const podsQuery = useQuery({
        queryKey: ["argocd-pods", projectId, selectedEnvironment, slug],
        queryFn: () => argoCdApi.getPods(projectId!, selectedEnvironment!, slug!),
        enabled: ready,
        refetchInterval: follow ? PODS_INTERVAL_MS : false
    })
    const pods = podsQuery.data ?? []
    // The pod picked while it lives, else the first: a rollout replaces them all
    const selectedPod = pods.some(candidate => candidate.name === pod) ? pod : pods[0]?.name

    const logsQuery = useQuery({
        queryKey: ["argocd-logs", projectId, selectedEnvironment, slug, selectedPod, tailLines, previous, filter],
        queryFn: () => argoCdApi.getLogs(projectId!, selectedEnvironment!, slug!, { pod: selectedPod!, tailLines, previous, filter }),
        enabled: ready && !!selectedPod,
        ...followedLogQuery(follow)
    })
    const lines = logsQuery.data ?? []

    if (isViewer || statusQuery.isPending || statusQuery.isError) return null

    const errorMessage = (error: Error | null) => {
        if (!error) return undefined
        const body = (error as AxiosError<{ error?: { message?: string; details?: GitOpsErrorDetails } }>).response?.data?.error
        const code = errorCodeOf(error)
        const own = code && LOGS_ERROR_KEYS[code]
        return (own ? t(own) : translateError(code, body?.details)) ?? body?.message ?? t("app.error.generic")
    }
    const error = errorMessage(podsQuery.error) ?? errorMessage(logsQuery.error)

    const refresh = () => {
        void podsQuery.refetch()
        if (selectedPod) void logsQuery.refetch()
    }

    return (
        <Card data-testid="application-logs">
            <CardHeader className="flex-row items-start justify-between gap-3">
                <div className="min-w-0">
                    <CardTitle className="mb-0 flex items-center gap-2">
                        <ScrollText className="size-5" aria-hidden="true" />
                        {t("applicationLogs.title")}
                    </CardTitle>
                    <CardDescription>{statusQuery.data?.initializedAt ? t("applicationLogs.description") : t("applicationLogs.not_configured")}</CardDescription>
                </div>
                {ready && (
                    <LogViewerActions
                        lines={selectedPod ? lines : []}
                        onRefresh={refresh}
                        refreshing={podsQuery.isFetching || logsQuery.isFetching}
                        downloadFileName={`${slug}-${selectedPod}.log`}
                        {...labels.actions}
                    />
                )}
            </CardHeader>
            {statusQuery.data?.initializedAt && (
                <CardContent className="flex flex-col gap-4 pt-3">
                    {environments.length === 0 ? (
                        <p className="text-sm text-foreground-secondary">{t("applicationLogs.no_environments")}</p>
                    ) : (
                        <LogViewer
                            lines={lines}
                            selectors={
                                <>
                                    {applications && (
                                        <div className="flex flex-col gap-1">
                                            <Label htmlFor={`${id}-application`}>{t("applicationLogs.application")}</Label>
                                            <Select layoutSize="sm" value={slug} onValueChange={setApplicationSlug}>
                                                <SelectTrigger id={`${id}-application`} className="w-56 max-w-full" dataTestId="application-logs-application">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {applications.map(application => (
                                                        <SelectItem key={application.slug} value={application.slug}>
                                                            {application.name}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    )}
                                    <div className="flex flex-col gap-1">
                                        <Label htmlFor={`${id}-environment`}>{t("applicationLogs.environment")}</Label>
                                        <Select layoutSize="sm" value={selectedEnvironment} onValueChange={setEnvironmentId}>
                                            <SelectTrigger id={`${id}-environment`} className="w-48" dataTestId="application-logs-environment">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {environments.map(environment => (
                                                    <SelectItem key={environment._id} value={environment._id!}>
                                                        {environment.name}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <div className="flex min-w-0 flex-col gap-1">
                                        <Label htmlFor={`${id}-pod`}>{t("applicationLogs.pod")}</Label>
                                        {pods.length > 0 ? (
                                            <Select layoutSize="sm" value={selectedPod} onValueChange={setPod}>
                                                <SelectTrigger id={`${id}-pod`} className="w-80 max-w-full" dataTestId="application-logs-pod">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {pods.map(candidate => (
                                                        <SelectItem key={candidate.name} value={candidate.name}>
                                                            {t("applicationLogs.pod_option", {
                                                                name: candidate.name,
                                                                status: candidate.status ?? candidate.health ?? "—",
                                                                count: candidate.restarts ?? 0
                                                            })}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        ) : (
                                            <p className="flex h-8 items-center text-sm text-foreground-secondary">{podsQuery.isFetching ? t("common.loading") : t("applicationLogs.no_pods")}</p>
                                        )}
                                    </div>
                                </>
                            }
                            tailLines={tailLines}
                            tailOptions={TAIL_OPTIONS}
                            onTailLinesChange={setTailLines}
                            onFilterChange={setFilter}
                            follow={follow}
                            onFollowChange={setFollow}
                            {...labels.viewer}
                            toggles={
                                <div className="flex items-center gap-2">
                                    <Checkbox id={`${id}-previous`} checked={previous} onCheckedChange={checked => setPrevious(checked === true)} />
                                    <Label htmlFor={`${id}-previous`} className="cursor-pointer" title={t("applicationLogs.previous_hint")}>
                                        {t("applicationLogs.previous")}
                                    </Label>
                                </div>
                            }
                            outputLabel={t("applicationLogs.title")}
                            emptyLabel={t("applicationLogs.empty")}
                            error={error}
                            pending={logsQuery.isPending}
                            placeholder={logsQuery.isPlaceholderData}
                            showOutput={!!selectedPod}
                            dataTestId="application-logs"
                        />
                    )}
                </CardContent>
            )}
        </Card>
    )
}

export default ApplicationLogsSection
