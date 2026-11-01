import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    DeleteConfirmationDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    LogViewer,
    LogViewerActions,
    type LogViewerLine,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow
} from "@flightroom/design-system"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { format, formatDistanceToNow } from "date-fns"
import { FileText, Trash2 } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Badge, Button, type IBadgeProps } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import useInstallationApi, {
    INSTALLATION_SANDBOXES_QUERY_KEY,
    type InstallationSandbox,
    SANDBOX_SETTINGS_QUERY_KEY,
    type SandboxLogLine,
    type SandboxPoolState,
    type SandboxUsage
} from "@/hooks/apiClients/useInstallationApi"
import useThemeStore from "@/store/useThemeStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"

/** Each refresh lists the gateway and asks the database about every key: no need to do it more often. */
const REFRESH_MS = 20_000

const POOL_VARIANTS: Record<SandboxPoolState, IBadgeProps["variant"]> = { warm: "success", creating: "info", assigned: "accent", legacy: "outline", orphan: "warning" }
const USAGE_VARIANTS: Record<SandboxUsage, IBadgeProps["variant"]> = { running: "success", busy: "info", idle: "outline", unknown: "outline" }

/** What a sandbox serves, in words: the domain or project, the conversation, or the live preview, with its project. */
const TargetLabel: React.FC<{ sandbox: InstallationSandbox }> = ({ sandbox }) => {
    const { t } = useTranslation()
    const target = sandbox.target
    if (!target) return <span className="text-foreground-secondary">{t("installation.sandboxes.target.none")}</span>
    return (
        <div className="flex min-w-0 flex-col">
            <span className="truncate">
                {t(`installation.sandboxes.target.${target.kind}`)}
                {target.name && `: ${target.name}`}
            </span>
            {target.projectName && <span className="truncate text-xs text-foreground-secondary">{target.projectName}</span>}
        </div>
    )
}

/** How many lines of a sandbox log can be read: the backend caps them at 2000. */
const TAIL_OPTIONS = [100, 200, 500, 1000, 2000]
/** While following, the log is read again this often, as for the logs of the applications */
const FOLLOW_INTERVAL_MS = 5_000

/** A line of the gateway as the viewer shows it: its source, level and target before the message, which may be JSON. */
const toViewerLine = (line: SandboxLogLine): LogViewerLine => ({
    timestamp: line.timestampMs ? new Date(line.timestampMs).toISOString() : undefined,
    content: [line.source && `[${line.source}]`, line.level, line.target, line.message].filter(Boolean).join(" ")
})

/** The last lines of the log of one sandbox, in the same viewer as the logs of the applications, followed by default. */
const SandboxLogsDialog: React.FC<{ name?: string; onClose: () => void }> = ({ name, onClose }) => {
    const { t } = useTranslation()
    const installationApi = useInstallationApi()
    const [tailLines, setTailLines] = useState(500)
    const [follow, setFollow] = useState(true)
    // The gateway has no filter: the lines read are filtered here
    const [filter, setFilter] = useState("")
    const logsQuery = useQuery({
        queryKey: [INSTALLATION_SANDBOXES_QUERY_KEY, "logs", name, tailLines],
        queryFn: () => installationApi.getSandboxLogs(name ?? "", tailLines),
        enabled: !!name,
        refetchInterval: follow ? FOLLOW_INTERVAL_MS : false,
        // The lines of before stay, dimmed, while the next ones load: the box does not jump
        placeholderData: previousLines => previousLines
    })
    const needle = filter.toLowerCase()
    const lines = (logsQuery.data ?? []).map(toViewerLine).filter(line => !needle || line.content.toLowerCase().includes(needle))

    return (
        <Dialog open={!!name} onOpenChange={open => !open && onClose()}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[1000px]">
                <DialogHeader className="flex-row items-start justify-between gap-3">
                    <div className="min-w-0">
                        <DialogTitle>{t("installation.sandboxes.logs.title", { name })}</DialogTitle>
                        <DialogDescription>{t("installation.sandboxes.logs.description")}</DialogDescription>
                    </div>
                    <LogViewerActions
                        lines={lines}
                        onRefresh={() => void logsQuery.refetch()}
                        refreshing={logsQuery.isFetching}
                        downloadFileName={`${name}.log`}
                        refreshLabel={t("applicationLogs.refresh")}
                        downloadLabel={t("applicationLogs.download")}
                        className="mr-6"
                        dataTestId="installation-sandbox-logs"
                    />
                </DialogHeader>
                <LogViewer
                    lines={lines}
                    tailLines={tailLines}
                    tailOptions={TAIL_OPTIONS}
                    onTailLinesChange={setTailLines}
                    tailLabel={t("applicationLogs.tail")}
                    tailOptionLabel={count => t("applicationLogs.tail_option", { count })}
                    onFilterChange={setFilter}
                    filterLabel={t("applicationLogs.filter")}
                    filterPlaceholder={t("applicationLogs.filter_placeholder")}
                    follow={follow}
                    onFollowChange={setFollow}
                    followLabel={t("applicationLogs.follow")}
                    formatJsonLabel={t("applicationLogs.format_json")}
                    formatJsonHint={t("applicationLogs.format_json_hint")}
                    outputLabel={t("installation.sandboxes.logs.title", { name })}
                    emptyLabel={t(logsQuery.data?.length ? "applicationLogs.empty" : "installation.sandboxes.logs.empty")}
                    loadingLabel={t("common.loading")}
                    error={logsQuery.isError && !logsQuery.data ? t("installation.sandboxes.logs.load_failed") : undefined}
                    pending={logsQuery.isPending}
                    placeholder={logsQuery.isPlaceholderData}
                    dataTestId="installation-sandbox-logs"
                />
            </DialogContent>
        </Dialog>
    )
}

/**
 * The sandboxes of this installation, never another one's: what each one serves, whether somebody uses it, its logs,
 * and deleting it. Deleting one a job runs in stops its live preview; its next command creates another sandbox.
 */
export const InstallationSandboxes: React.FC = () => {
    const { t } = useTranslation()
    const themeStore = useThemeStore()
    const installationApi = useInstallationApi()
    const notifications = useToastNotificationStore()
    const queryClient = useQueryClient()
    const [logsOf, setLogsOf] = useState<string>()
    const [toDelete, setToDelete] = useState<InstallationSandbox>()

    const sandboxesQuery = useQuery({ queryKey: [INSTALLATION_SANDBOXES_QUERY_KEY], queryFn: installationApi.getSandboxes, refetchInterval: REFRESH_MS })

    const deleteMutation = useMutation({
        mutationFn: (name: string) => installationApi.deleteSandbox(name),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: [INSTALLATION_SANDBOXES_QUERY_KEY] })
            queryClient.invalidateQueries({ queryKey: [SANDBOX_SETTINGS_QUERY_KEY] })
            notifications.showSuccessNotification({ message: t("installation.sandboxes.delete.deleted") })
        },
        onError: () => notifications.showErrorNotification({ message: t("installation.sandboxes.delete.failed") })
    })

    const running = toDelete?.usage === "running"

    return (
        <Card className="pt-4" data-testid="installation-sandboxes">
            <CardHeader>
                <CardTitle as="h2">{t("installation.sandboxes.title")}</CardTitle>
                <CardDescription>{t("installation.sandboxes.description")}</CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
                {/* Only the first load goes through ApiStatusHandler: it hides its children while a query fetches, so every poll would flash the table */}
                {sandboxesQuery.data === undefined ? (
                    <ApiStatusHandler queries={[sandboxesQuery]}>{null}</ApiStatusHandler>
                ) : sandboxesQuery.data.length === 0 ? (
                    <p className="text-sm text-foreground-secondary">{t("installation.sandboxes.empty")}</p>
                ) : (
                    <div className="overflow-x-auto">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("installation.sandboxes.columns.name")}</TableHead>
                                    <TableHead>{t("installation.sandboxes.columns.pool")}</TableHead>
                                    <TableHead>{t("installation.sandboxes.columns.target")}</TableHead>
                                    <TableHead>{t("installation.sandboxes.columns.organization")}</TableHead>
                                    <TableHead>{t("installation.sandboxes.columns.usage")}</TableHead>
                                    <TableHead>{t("installation.sandboxes.columns.age")}</TableHead>
                                    <TableHead>
                                        <span className="sr-only">{t("installation.sandboxes.columns.actions")}</span>
                                    </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {sandboxesQuery.data.map(sandbox => (
                                    <TableRow key={sandbox.name} data-testid={`installation-sandbox-${sandbox.name}`}>
                                        <TableCell>
                                            <div className="flex flex-col">
                                                <span className="font-mono text-xs">{sandbox.name}</span>
                                                <span className="text-xs text-foreground-secondary">{sandbox.phase ?? t("installation.sandboxes.phase_unknown")}</span>
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant={POOL_VARIANTS[sandbox.pool]}>{t(`installation.sandboxes.pool.${sandbox.pool}`)}</Badge>
                                            {sandbox.shared && <span className="ml-2 text-xs text-foreground-secondary">{t("installation.sandboxes.shared")}</span>}
                                        </TableCell>
                                        <TableCell className="max-w-[280px]">
                                            <TargetLabel sandbox={sandbox} />
                                        </TableCell>
                                        <TableCell>{sandbox.organization?.name ?? <span className="text-foreground-secondary">-</span>}</TableCell>
                                        <TableCell>
                                            {sandbox.usage ? (
                                                <Badge variant={USAGE_VARIANTS[sandbox.usage]}>{t(`installation.sandboxes.usage.${sandbox.usage}`)}</Badge>
                                            ) : (
                                                <span className="text-foreground-secondary">-</span>
                                            )}
                                        </TableCell>
                                        <TableCell className="whitespace-nowrap">
                                            {sandbox.createdAt ? (
                                                <span title={format(new Date(sandbox.createdAt), "PPp", { locale: themeStore.getLocale() })}>
                                                    {formatDistanceToNow(new Date(sandbox.createdAt), { locale: themeStore.getLocale() })}
                                                </span>
                                            ) : (
                                                "-"
                                            )}
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex justify-end gap-1">
                                                <Button
                                                    variant="ghost"
                                                    size="icon-sm"
                                                    aria-label={t("installation.sandboxes.logs.open", { name: sandbox.name })}
                                                    title={t("installation.sandboxes.logs.open", { name: sandbox.name })}
                                                    disabled={!sandbox.phase}
                                                    onClick={() => setLogsOf(sandbox.name)}
                                                    dataTestId={`installation-sandbox-logs-${sandbox.name}`}
                                                >
                                                    <FileText className="size-4" aria-hidden="true" />
                                                </Button>
                                                <Button
                                                    variant="ghost-destructive"
                                                    size="icon-sm"
                                                    aria-label={t("installation.sandboxes.delete.open", { name: sandbox.name })}
                                                    title={t("installation.sandboxes.delete.open", { name: sandbox.name })}
                                                    onClick={() => setToDelete(sandbox)}
                                                    dataTestId={`installation-sandbox-delete-${sandbox.name}`}
                                                >
                                                    <Trash2 className="size-4" aria-hidden="true" />
                                                </Button>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                )}
            </CardContent>

            <SandboxLogsDialog name={logsOf} onClose={() => setLogsOf(undefined)} />
            <DeleteConfirmationDialog
                isOpen={!!toDelete}
                onOpenChange={open => !open && setToDelete(undefined)}
                onDelete={async () => {
                    if (toDelete) await deleteMutation.mutateAsync(toDelete.name)
                }}
                onDeleteSuccess={() => setToDelete(undefined)}
                title={t("installation.sandboxes.delete.title", { name: toDelete?.name ?? "" })}
                description={`${t(running ? "installation.sandboxes.delete.running" : "installation.sandboxes.delete.description")} ${toDelete?.pool === "warm" ? t("installation.sandboxes.delete.warm") : ""}`.trim()}
                cancelLabel={t("common.cancel")}
                deleteLabel={t("common.delete")}
                deletingLabel={t("installation.sandboxes.delete.deleting")}
                dataTestId="installation-sandbox-delete-dialog"
            />
        </Card>
    )
}

export default InstallationSandboxes
