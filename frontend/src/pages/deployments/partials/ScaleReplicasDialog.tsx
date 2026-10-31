import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label } from "@flightroom/design-system"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowRight, Rocket, Save } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Badge, Button } from "@/components/atoms"
import EnvironmentSelector from "@/components/molecules/EnvironmentSelector"
import useEnvironmentsApi, { type EnvironmentDTO, type ReplicasRow } from "@/hooks/apiClients/useEnvironmentsApi"
import { MAX_REPLICAS } from "@/pages/backends/partials/containerResources"
import useToastNotificationStore from "@/store/useToastNotificationStore"

/** Stable while the query has no data */
const NO_ROWS: ReplicasRow[] = []

/** The queries that show the replicas of a container: setting them changes them */
const SCALED_QUERIES = ["backends", "backend", "frontends-by-project-id", "frontend", "maintenance-agents", "maintenance-agent", "environment-replicas"]

/** A whole number from 0 to MAX_REPLICAS, as typed */
const replicaCount = (value: string): number | undefined => (/^\d{1,2}$/.test(value.trim()) && Number(value) <= MAX_REPLICAS ? Number(value) : undefined)

interface ScaleReplicasDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    environments: EnvironmentDTO[]
    /** The environment scaled when the dialog opens: the one the page shows */
    defaultEnvironment?: EnvironmentDTO
    /** Deploys the environment once the replicas are saved */
    onDeploy: (environmentId: string) => void
}

/**
 * Sets the pods of every container an environment runs at once, e.g. 0 to stop UAT for the night. Saved only, the
 * next deploy of the environment applies them.
 */
export const ScaleReplicasDialog: React.FC<ScaleReplicasDialogProps> = ({ open, onOpenChange, environments, defaultEnvironment, onDeploy }) => {
    const { t } = useTranslation()
    const environmentsApi = useEnvironmentsApi()
    const queryClient = useQueryClient()
    const notifications = useToastNotificationStore()
    const [environment, setEnvironment] = useState<EnvironmentDTO | undefined>(defaultEnvironment)
    const [value, setValue] = useState("1")

    // Each opening starts from the environment the page shows
    useEffect(() => {
        if (open) setEnvironment(defaultEnvironment)
    }, [open, defaultEnvironment])

    const { data: rows = NO_ROWS, isLoading } = useQuery({
        queryKey: ["environment-replicas", environment?._id],
        queryFn: () => environmentsApi.getReplicas(environment._id),
        enabled: open && Boolean(environment?._id)
    })

    const replicas = replicaCount(value)
    const changed = replicas === undefined ? 0 : rows.filter(row => row.replicas !== replicas).length

    const scaling = useMutation({
        mutationFn: () => environmentsApi.setReplicas(environment._id, replicas),
        onSuccess: () => {
            for (const key of SCALED_QUERIES) queryClient.invalidateQueries({ queryKey: [key] })
        }
    })

    const save = async (andDeploy: boolean) => {
        try {
            await scaling.mutateAsync()
        } catch {
            // The API client has already shown why
            return
        }
        notifications.showSuccessNotification({ message: t("deployments.replicas.saved", { count: rows.length, replicas, environment: environment.name }) })
        onOpenChange(false)
        if (andDeploy) onDeploy(environment._id)
    }

    const disabled = !environment?._id || replicas === undefined || rows.length === 0 || scaling.isPending

    return (
        <Dialog open={open} onOpenChange={next => !scaling.isPending && onOpenChange(next)}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{t("deployments.replicas.title")}</DialogTitle>
                    <DialogDescription>{t("deployments.replicas.description")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-wrap items-end gap-3">
                    <EnvironmentSelector label={t("deployments.replicas.environment")} selectedEnvironment={environment} environments={environments} onEnvironmentChange={setEnvironment} />
                    <div className="flex w-28 flex-col gap-1.5">
                        <Label htmlFor="scale-replicas">{t("deployments.replicas.count")}</Label>
                        <Input
                            id="scale-replicas"
                            type="number"
                            inputMode="numeric"
                            min={0}
                            max={MAX_REPLICAS}
                            value={value}
                            onChange={event => setValue(event.target.value)}
                            aria-invalid={replicas === undefined}
                            data-testid="scale-replicas-count"
                        />
                    </div>
                </div>
                {replicas === undefined ? (
                    <p className="text-sm text-destructive">{t("backends.compute.replicas_invalid", { max: MAX_REPLICAS })}</p>
                ) : (
                    replicas === 0 && <p className="text-sm text-foreground-secondary">{t("deployments.replicas.zero_hint")}</p>
                )}
                {isLoading ? (
                    <p className="text-sm text-foreground-secondary">{t("common.loading")}</p>
                ) : rows.length === 0 ? (
                    <p className="text-sm text-foreground-secondary">{t("deployments.replicas.empty", { environment: environment?.name })}</p>
                ) : (
                    <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto" data-testid="replicas-rows">
                        {rows.map(row => {
                            const changes = replicas !== undefined && row.replicas !== replicas
                            return (
                                <li key={`${row.kind}:${row._id}`} className={`flex items-center gap-3 rounded-md border border-divider p-3 ${changes ? "" : "opacity-60"}`}>
                                    <span className="flex min-w-0 flex-1 items-center gap-2">
                                        <span className="truncate text-sm font-medium">{row.name}</span>
                                        <Badge variant="outline">{t(`deployments.promotion.kinds.${row.kind}`)}</Badge>
                                    </span>
                                    <span className="flex shrink-0 items-center gap-2 font-mono text-sm">
                                        <span>{row.replicas}</span>
                                        {changes && (
                                            <>
                                                <ArrowRight className="size-3 text-foreground-secondary" aria-hidden="true" />
                                                <span className="font-semibold">{replicas}</span>
                                            </>
                                        )}
                                    </span>
                                </li>
                            )
                        })}
                    </ul>
                )}
                {replicas !== undefined && rows.length > 0 && <p className="text-xs text-foreground-secondary">{t("deployments.replicas.changes", { count: changed })}</p>}
                <DialogFooter>
                    <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={scaling.isPending}>
                        {t("common.cancel")}
                    </Button>
                    <Button type="button" variant="secondary" onClick={() => save(false)} disabled={disabled} dataTestId="replicas-save">
                        <Save />
                        {t("deployments.promotion.save")}
                    </Button>
                    <Button
                        type="button"
                        onClick={() => save(true)}
                        disabled={disabled}
                        loading={scaling.isPending}
                        loadingLabel={t("deployments.promotion.saving")}
                        dataTestId="replicas-save-and-deploy"
                    >
                        <Rocket />
                        {t("deployments.promotion.save_and_deploy", { environment: environment?.name })}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}

export default ScaleReplicasDialog
