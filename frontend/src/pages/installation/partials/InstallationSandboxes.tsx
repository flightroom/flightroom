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
    Spinner,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow
} from "@flightroom/design-system"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { format, formatDistanceToNow } from "date-fns"
import { FileText, RefreshCw, Trash2 } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Badge, Button, type IBadgeProps } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import useInstallationApi, {
    INSTALLATION_SANDBOXES_QUERY_KEY,
    type InstallationSandbox,
    SANDBOX_SETTINGS_QUERY_KEY,
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

/** The last lines of the log of one sandbox, read again on demand. */
const SandboxLogsDialog: React.FC<{ name?: string; onClose: () => void }> = ({ name, onClose }) => {
    const { t } = useTranslation()
    const themeStore = useThemeStore()
    const installationApi = useInstallationApi()
    const logsQuery = useQuery({ queryKey: [INSTALLATION_SANDBOXES_QUERY_KEY, "logs", name], queryFn: () => installationApi.getSandboxLogs(name ?? ""), enabled: !!name })

    return (
        <Dialog open={!!name} onOpenChange={open => !open && onClose()}>
            <DialogContent className="max-h-[90vh] sm:max-w-[900px]">
                <DialogHeader>
                    <DialogTitle>{t("installation.sandboxes.logs.title", { name })}</DialogTitle>
                    <DialogDescription>{t("installation.sandboxes.logs.description")}</DialogDescription>
                </DialogHeader>
                <div className="flex justify-end">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => logsQuery.refetch()}
                        loading={logsQuery.isFetching}
                        loadingLabel={t("common.loading")}
                        dataTestId="installation-sandbox-logs-refresh"
                    >
                        <RefreshCw className="size-4" aria-hidden="true" />
                        {t("installation.sandboxes.logs.refresh")}
                    </Button>
                </div>
                {logsQuery.isPending ? (
                    <Spinner size={16} centerScreen={false} label={t("common.loading")} />
                ) : logsQuery.isError ? (
                    <p className="text-sm text-foreground-secondary">{t("installation.sandboxes.logs.load_failed")}</p>
                ) : logsQuery.data.length === 0 ? (
                    <p className="text-sm text-foreground-secondary">{t("installation.sandboxes.logs.empty")}</p>
                ) : (
                    <pre className="max-h-[60vh] overflow-auto rounded-md border border-divider p-3 text-xs" data-testid="installation-sandbox-logs">
                        {logsQuery.data
                            .map(line =>
                                [line.timestampMs ? format(new Date(line.timestampMs), "Pp", { locale: themeStore.getLocale() }) : "", line.source, line.level, line.target, line.message]
                                    .filter(Boolean)
                                    .join("  ")
                            )
                            .join("\n")}
                    </pre>
                )}
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
                <ApiStatusHandler queries={[sandboxesQuery]} emptyLabel={t("installation.sandboxes.empty")}>
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
                                {(sandboxesQuery.data ?? []).map(sandbox => (
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
                </ApiStatusHandler>
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
