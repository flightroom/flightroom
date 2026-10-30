import { Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@flightroom/design-system"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowRight, Rocket, Save } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Badge, Button } from "@/components/atoms"
import EnvironmentSelector from "@/components/molecules/EnvironmentSelector"
import useEnvironmentsApi, { type EnvironmentDTO, type PromotionRow, promotes } from "@/hooks/apiClients/useEnvironmentsApi"
import useToastNotificationStore from "@/store/useToastNotificationStore"

/** Stable while the query has no data: a new [] at each render would reset the selection in a loop */
const NO_ROWS: PromotionRow[] = []

const keyOf = (row: Pick<PromotionRow, "kind" | "_id">) => `${row.kind}:${row._id}`

/** The queries that show a version per environment: a promotion changes them */
const PROMOTED_QUERIES = ["backends", "backend", "frontends-by-project-id", "frontend", "maintenance-agents", "maintenance-agent", "environment-promotion"]

/** The environment before `to` in the order of the project, e.g. development for UAT: the first one takes the next */
const sourceFor = (environments: EnvironmentDTO[], toId?: string) => {
    const index = environments.findIndex(environment => environment._id === toId)
    return environments[index > 0 ? index - 1 : 1]
}

interface PromoteVersionsDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    environments: EnvironmentDTO[]
    /** The environment the versions go to when the dialog opens: the one the page shows */
    defaultTarget?: EnvironmentDTO
    /** Deploys the target once the versions are saved */
    onDeploy: (environmentId: string) => void
}

/**
 * Brings the versions an environment runs to another, e.g. from development to UAT: each application picked gets in
 * the target the version it has in the source. Saved only, the next deploy of the target applies them.
 */
export const PromoteVersionsDialog: React.FC<PromoteVersionsDialogProps> = ({ open, onOpenChange, environments, defaultTarget, onDeploy }) => {
    const { t } = useTranslation()
    const environmentsApi = useEnvironmentsApi()
    const queryClient = useQueryClient()
    const notifications = useToastNotificationStore()
    const [to, setTo] = useState<EnvironmentDTO | undefined>(defaultTarget)
    const [from, setFrom] = useState<EnvironmentDTO | undefined>(sourceFor(environments, defaultTarget?._id))
    const [selected, setSelected] = useState<Set<string>>(new Set())

    // Each opening starts from the environment the page shows
    useEffect(() => {
        if (!open) return
        setTo(defaultTarget)
        setFrom(sourceFor(environments, defaultTarget?._id))
    }, [open, defaultTarget, environments])

    const ready = open && Boolean(from?._id && to?._id) && from?._id !== to?._id
    const { data: rows = NO_ROWS, isLoading } = useQuery({
        queryKey: ["environment-promotion", to?._id, from?._id],
        queryFn: () => environmentsApi.getPromotion(to._id, from._id),
        enabled: ready
    })

    // Every application the promotion changes is picked to start with
    useEffect(() => setSelected(new Set(rows.filter(promotes).map(keyOf))), [rows])

    const promotion = useMutation({
        mutationFn: () =>
            environmentsApi.promote(
                to._id,
                from._id,
                rows.filter(row => promotes(row) && selected.has(keyOf(row))).map(({ kind, _id }) => ({ kind, _id }))
            ),
        onSuccess: () => {
            for (const key of PROMOTED_QUERIES) queryClient.invalidateQueries({ queryKey: [key] })
        }
    })

    const save = async (andDeploy: boolean) => {
        const count = selected.size
        try {
            await promotion.mutateAsync()
        } catch {
            // The API client has already shown why
            return
        }
        notifications.showSuccessNotification({ message: t("deployments.promotion.saved", { count, from: from.name, to: to.name }) })
        onOpenChange(false)
        if (andDeploy) onDeploy(to._id)
    }

    const toggle = (row: PromotionRow, checked: boolean) =>
        setSelected(current => {
            const next = new Set(current)
            if (checked) next.add(keyOf(row))
            else next.delete(keyOf(row))
            return next
        })

    /** Why a row is left out: it already runs the version, or the source does not run it */
    const unchangedReason = (row: PromotionRow) => (row.from ? t("deployments.promotion.aligned") : t("deployments.promotion.not_in_source", { environment: from?.name }))

    return (
        <Dialog open={open} onOpenChange={value => !promotion.isPending && onOpenChange(value)}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{t("deployments.promotion.title")}</DialogTitle>
                    <DialogDescription>{t("deployments.promotion.description")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-wrap items-end gap-3">
                    <EnvironmentSelector label={t("deployments.promotion.from")} selectedEnvironment={from} environments={environments} onEnvironmentChange={setFrom} />
                    <ArrowRight className="mb-2.5 size-4 text-foreground-secondary" aria-hidden="true" />
                    <EnvironmentSelector label={t("deployments.promotion.to")} selectedEnvironment={to} environments={environments} onEnvironmentChange={setTo} />
                </div>
                {from?._id && from._id === to?._id ? (
                    <p className="text-sm text-foreground-secondary">{t("deployments.promotion.same_environment")}</p>
                ) : isLoading ? (
                    <p className="text-sm text-foreground-secondary">{t("common.loading")}</p>
                ) : rows.length === 0 ? (
                    <p className="text-sm text-foreground-secondary">{t("deployments.promotion.empty")}</p>
                ) : (
                    <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto" data-testid="promotion-rows">
                        {rows.map(row => {
                            const changes = promotes(row)
                            const id = `promotion-${keyOf(row)}`
                            return (
                                <li key={keyOf(row)} className={`flex items-center gap-3 rounded-md border border-divider p-3 ${changes ? "" : "opacity-60"}`}>
                                    <Checkbox
                                        id={id}
                                        checked={changes && selected.has(keyOf(row))}
                                        disabled={!changes || promotion.isPending}
                                        onCheckedChange={checked => toggle(row, checked === true)}
                                        aria-label={row.name}
                                    />
                                    <label htmlFor={id} className="flex min-w-0 flex-1 flex-col gap-0.5">
                                        <span className="flex items-center gap-2">
                                            <span className="truncate text-sm font-medium">{row.name}</span>
                                            <Badge variant="outline">{t(`deployments.promotion.kinds.${row.kind}`)}</Badge>
                                        </span>
                                        {!changes && <span className="text-xs text-foreground-secondary">{unchangedReason(row)}</span>}
                                    </label>
                                    <span className="flex shrink-0 items-center gap-2 font-mono text-sm">
                                        <span className={row.to ? "" : "text-foreground-secondary"}>{row.to ?? t("deployments.promotion.none")}</span>
                                        {changes && (
                                            <>
                                                <ArrowRight className="size-3 text-foreground-secondary" aria-hidden="true" />
                                                <span className="font-semibold">{row.from}</span>
                                            </>
                                        )}
                                    </span>
                                </li>
                            )
                        })}
                    </ul>
                )}
                <DialogFooter>
                    <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={promotion.isPending}>
                        {t("common.cancel")}
                    </Button>
                    <Button type="button" variant="secondary" onClick={() => save(false)} disabled={!ready || selected.size === 0 || promotion.isPending} dataTestId="promotion-save">
                        <Save />
                        {t("deployments.promotion.save")}
                    </Button>
                    <Button
                        type="button"
                        onClick={() => save(true)}
                        disabled={!ready || selected.size === 0 || promotion.isPending}
                        loading={promotion.isPending}
                        loadingLabel={t("deployments.promotion.saving")}
                        dataTestId="promotion-save-and-deploy"
                    >
                        <Rocket />
                        {t("deployments.promotion.save_and_deploy", { environment: to?.name })}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}

export default PromoteVersionsDialog
