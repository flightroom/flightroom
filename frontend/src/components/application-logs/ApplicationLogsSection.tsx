import { Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Spinner } from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { AxiosError } from "axios"
import { Download, RefreshCw, ScrollText } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import useArgoCdApi, { ArgoCdLogLine } from "@/hooks/apiClients/useArgoCdApi"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import { GitOpsErrorDetails, useGitOpsErrorTranslation } from "@/hooks/apiClients/useGitOpsErrorMessage"
import { errorCodeOf } from "@/hooks/useApiClient"
import useProjectStore, { useIsProjectViewer } from "@/store/useProjectStore"
import LogLine from "./LogLine"

const TAIL_OPTIONS = [100, 500, 1000, 5000]
/** While following, the logs are read again this often, and the pods, which come and go with a rollout, less often */
const FOLLOW_INTERVAL_MS = 5_000
const PODS_INTERVAL_MS = 15_000
/** The filter goes to Argo CD once the typing stops */
const FILTER_DEBOUNCE_MS = 400

/** The refusals of the logs themselves; those of Argo CD translate as on the settings screen */
const LOGS_ERROR_KEYS: Record<string, string> = {
    ARGOCD_NOT_CONFIGURED: "applicationLogs.errors.not_configured",
    ARGOCD_LOGS_FORBIDDEN: "applicationLogs.errors.forbidden",
    ARGOCD_LOGS_INVALID: "applicationLogs.errors.invalid"
}

const lineText = (line: ArgoCdLogLine) => (line.timestamp ? `${line.timestamp} ${line.content}` : line.content)

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
    const [filterDraft, setFilterDraft] = useState("")
    const [filter, setFilter] = useState("")
    const [follow, setFollow] = useState(false)
    const [formatJson, setFormatJson] = useState(true)
    const outputRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const timeout = setTimeout(() => setFilter(filterDraft.trim()), FILTER_DEBOUNCE_MS)
        return () => clearTimeout(timeout)
    }, [filterDraft])

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
        refetchInterval: follow ? FOLLOW_INTERVAL_MS : false,
        // The lines of before stay, dimmed, while the next ones load: the box does not jump
        placeholderData: previousLines => previousLines
    })
    const lines = logsQuery.data ?? []

    // The newest line in sight, as a terminal tailing a log
    useEffect(() => {
        if (logsQuery.data && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight
    }, [logsQuery.data])

    if (isViewer || statusQuery.isPending || statusQuery.isError) return null

    const errorMessage = (error: Error | null) => {
        if (!error) return undefined
        const body = (error as AxiosError<{ error?: { message?: string; details?: GitOpsErrorDetails } }>).response?.data?.error
        const code = errorCodeOf(error)
        const own = code && LOGS_ERROR_KEYS[code]
        return (own ? t(own) : translateError(code, body?.details)) ?? body?.message ?? t("app.error.generic")
    }
    const error = errorMessage(podsQuery.error) ?? errorMessage(logsQuery.error)

    const download = () => {
        const url = URL.createObjectURL(new Blob([lines.map(lineText).join("\n")], { type: "text/plain" }))
        const link = document.createElement("a")
        link.href = url
        link.download = `${slug}-${selectedPod}.log`
        link.click()
        // Revoked once the browser has started the download: at once, some cancel it
        setTimeout(() => URL.revokeObjectURL(url), 1_000)
    }

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
                    <div className="flex shrink-0 gap-2">
                        <Button variant="secondary" size="sm" onClick={refresh} disabled={podsQuery.isFetching || logsQuery.isFetching} aria-label={t("applicationLogs.refresh")}>
                            <RefreshCw className={podsQuery.isFetching || logsQuery.isFetching ? "animate-spin" : undefined} />
                            {t("applicationLogs.refresh")}
                        </Button>
                        <Button variant="secondary" size="sm" onClick={download} disabled={!selectedPod || lines.length === 0} aria-label={t("applicationLogs.download")}>
                            <Download />
                            {t("applicationLogs.download")}
                        </Button>
                    </div>
                )}
            </CardHeader>
            {statusQuery.data?.initializedAt && (
                <CardContent className="flex flex-col gap-4 pt-3">
                    {environments.length === 0 ? (
                        <p className="text-sm text-foreground-secondary">{t("applicationLogs.no_environments")}</p>
                    ) : (
                        <>
                            <div className="flex flex-wrap items-end gap-3">
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
                                <div className="flex flex-col gap-1">
                                    <Label htmlFor={`${id}-tail`}>{t("applicationLogs.tail")}</Label>
                                    <Select layoutSize="sm" value={String(tailLines)} onValueChange={value => setTailLines(Number(value))}>
                                        <SelectTrigger id={`${id}-tail`} className="w-40">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {TAIL_OPTIONS.map(option => (
                                                <SelectItem key={option} value={String(option)}>
                                                    {t("applicationLogs.tail_option", { count: option })}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="flex min-w-48 flex-1 flex-col gap-1">
                                    <Label htmlFor={`${id}-filter`}>{t("applicationLogs.filter")}</Label>
                                    <Input
                                        id={`${id}-filter`}
                                        value={filterDraft}
                                        placeholder={t("applicationLogs.filter_placeholder")}
                                        onChange={event => setFilterDraft(event.target.value)}
                                        maxLength={200}
                                        fullWidth
                                    />
                                </div>
                            </div>
                            <div className="flex flex-wrap gap-4">
                                <div className="flex items-center gap-2">
                                    <Checkbox id={`${id}-follow`} checked={follow} onCheckedChange={checked => setFollow(checked === true)} dataTestId="application-logs-follow" />
                                    <Label htmlFor={`${id}-follow`} className="cursor-pointer">
                                        {t("applicationLogs.follow")}
                                    </Label>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Checkbox id={`${id}-json`} checked={formatJson} onCheckedChange={checked => setFormatJson(checked === true)} dataTestId="application-logs-format-json" />
                                    <Label htmlFor={`${id}-json`} className="cursor-pointer" title={t("applicationLogs.format_json_hint")}>
                                        {t("applicationLogs.format_json")}
                                    </Label>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Checkbox id={`${id}-previous`} checked={previous} onCheckedChange={checked => setPrevious(checked === true)} />
                                    <Label htmlFor={`${id}-previous`} className="cursor-pointer" title={t("applicationLogs.previous_hint")}>
                                        {t("applicationLogs.previous")}
                                    </Label>
                                </div>
                            </div>
                            {error ? (
                                <p className="text-sm text-destructive" role="alert">
                                    {error}
                                </p>
                            ) : logsQuery.isPending && selectedPod ? (
                                <div className="flex min-h-[96px] items-center justify-center">
                                    <Spinner size={24} centerScreen={false} label={t("common.loading")} />
                                </div>
                            ) : (
                                selectedPod && (
                                    // A div, not a pre: a formatted JSON line opens as a details element
                                    <div
                                        ref={outputRef}
                                        role="log"
                                        className={`max-h-[480px] min-h-[96px] overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all ${logsQuery.isPlaceholderData ? "opacity-60" : ""}`}
                                        aria-label={t("applicationLogs.title")}
                                        data-testid="application-logs-output"
                                    >
                                        {lines.length === 0 ? t("applicationLogs.empty") : lines.map((line, index) => <LogLine key={index} line={line} formatJson={formatJson} />)}
                                    </div>
                                )
                            )}
                        </>
                    )}
                </CardContent>
            )}
        </Card>
    )
}

export default ApplicationLogsSection
