import { ColorSwatch, ConfirmByTypingDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@flightroom/design-system"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowRight, GripVertical, Plus } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useSearchParams } from "react-router-dom"
import { Badge, Button } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import SinglePageLayout from "@/components/SinglePageLayout"
import { DeleteConfirmationDialog } from "@/components/ui/DeleteConfirmationDialog"
import useEnvironmentsApi, { EnvironmentDTO, KUBE_GREEN_DEFAULTS } from "@/hooks/apiClients/useEnvironmentsApi"
import useProjectApi from "@/hooks/apiClients/useProjectApi"
import useDragAndDropOrder from "@/hooks/useDragAndDropOrder"
import useProjectStore from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import EnvironmentsGate from "@/theme/EnvironmentsGate"
import { getRandomColor } from "@/utils/StringUtils"
import { cn } from "@/utils/styleUtils"
import EnvironmentEditor, { EnvironmentFormData } from "./partials/EnvironmentEditor"

/** Selezione della tessera "nuovo ambiente": l'editor si apre vuoto */
const NEW = "new"

/** L'ambiente aperto sta nell'URL (`?env=DEV`, `?env=new` in creazione): un link porta a quell'ambiente */
const ENV_PARAM = "env"

const newDraft = (): EnvironmentFormData => ({
    name: "",
    slug: "",
    description: "",
    color: getRandomColor(),
    isProduction: false,
    logLevel: "info",
    logJson: true,
    kubeGreen: KUBE_GREEN_DEFAULTS
})

/** Da tastiera ogni freccia sposta di un posto: l'ordine si salva una volta sola, quando gli spostamenti si fermano */
const REORDER_SAVE_DELAY_MS = 600

export default function EnvironmentsPage() {
    const { t } = useTranslation()

    const { deleteEnvironment, updateEnvironmentsOrder } = useEnvironmentsApi()
    const projectApi = useProjectApi()
    const notifications = useToastNotificationStore()
    const queryClient = useQueryClient()
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
    // Slug dell'ambiente aperto nell'editor, NEW per la creazione; senza scelta, o con uno slug che non c'e', vale il primo
    const [searchParams, setSearchParams] = useSearchParams()
    const selectedSlug = searchParams.get(ENV_PARAM) ?? undefined
    const [draft, setDraft] = useState(newDraft)
    const [isEditorDirty, setIsEditorDirty] = useState(false)
    // Tessera scelta mentre l'editor ha modifiche non salvate: si cambia solo dopo la conferma
    const [pendingSelection, setPendingSelection] = useState<string>()
    const [orderedEnvironments, setOrderedEnvironments] = useState<EnvironmentDTO[]>([])
    const pendingOrder = useRef<EnvironmentDTO[]>(undefined)
    const saveOrderTimeout = useRef<ReturnType<typeof setTimeout>>(undefined)
    const { project, setEnvironments } = useProjectStore()
    const isGitOpsEnabled = Boolean(project?.gitOps?.enabled)

    const environmentQuery = useQuery({
        queryKey: ["environments", project._id],
        queryFn: () => projectApi.getEnvironmentsByProjectId(project._id)
    })

    useEffect(() => {
        // Un ordine ancora da salvare vince sui dati arrivati nel frattempo
        if (!pendingOrder.current) setOrderedEnvironments(environmentQuery.data ?? [])
    }, [environmentQuery.data])

    const selected = orderedEnvironments.find(env => env.slug === selectedSlug) ?? (selectedSlug === NEW ? undefined : orderedEnvironments[0])
    const isCreating = selected === undefined && selectedSlug === NEW
    const canReorder = orderedEnvironments.length > 1

    const setSelectedSlug = (slug?: string) =>
        setSearchParams(
            params => {
                if (slug) params.set(ENV_PARAM, slug)
                else params.delete(ENV_PARAM)
                return params
            },
            { replace: true }
        )

    // L'URL riporta sempre l'ambiente mostrato, anche quando e' il primo scelto per default
    // biome-ignore lint/correctness/useExhaustiveDependencies: setSelectedSlug cambia a ogni render, conta solo l'ambiente mostrato
    useEffect(() => {
        if (selected && selected.slug !== selectedSlug) setSelectedSlug(selected.slug)
    }, [selected?.slug, selectedSlug])

    const updateOrderMutation = useMutation({
        mutationFn: (environments: EnvironmentDTO[]) => updateEnvironmentsOrder(environments.map(env => env._id)),
        onSuccess: async (environments: EnvironmentDTO[]) => {
            // Apply the new order everywhere: project store (used by all the other pages) and environments query
            setEnvironments(environments)
            await queryClient.invalidateQueries({ queryKey: ["environments", project._id] })
            notifications.showSuccessNotification({
                message: t("environment.page.reorder.success")
            })
        },
        onError: () => {
            // Restore the persisted order
            setOrderedEnvironments(environmentQuery.data ?? [])
        }
    })

    const saveOrder = () => {
        clearTimeout(saveOrderTimeout.current)
        if (pendingOrder.current) updateOrderMutation.mutate(pendingOrder.current)
        pendingOrder.current = undefined
    }

    // Lasciando la pagina prima dell'attesa, l'ordine si salva subito invece di perdersi
    // biome-ignore lint/correctness/useExhaustiveDependencies: solo allo smontaggio; saveOrder legge l'ordine dai ref, e mutate non cambia fra un render e l'altro
    useEffect(() => saveOrder, [])

    const onReorder = (environments: EnvironmentDTO[]) => {
        setOrderedEnvironments(environments)
        pendingOrder.current = environments
        clearTimeout(saveOrderTimeout.current)
        saveOrderTimeout.current = setTimeout(saveOrder, REORDER_SAVE_DELAY_MS)
    }

    const { draggingId, dragOverId, getHandleProps, getItemProps } = useDragAndDropOrder({
        items: orderedEnvironments,
        getId: env => env._id,
        onReorder,
        disabled: updateOrderMutation.isPending
    })

    const onSaved = async (environment: EnvironmentDTO) => {
        await environmentQuery.refetch()
        setSelectedSlug(environment.slug)
    }

    const openCreate = () => {
        setDraft(newDraft())
        setSelectedSlug(NEW)
    }

    const select = (slug: string) => (slug === NEW ? openCreate() : setSelectedSlug(slug))

    const requestSelection = (slug: string) => {
        if (slug === (isCreating ? NEW : selected?.slug)) return
        if (isEditorDirty) setPendingSelection(slug)
        else select(slug)
    }

    const discardAndSelect = () => {
        if (pendingSelection) select(pendingSelection)
        setPendingSelection(undefined)
    }

    const handleDelete = async () => {
        if (!selected?._id) return

        await deleteEnvironment(selected._id)
        // Chiuso qui: il dialog resterebbe aperto sull'ambiente selezionato dopo, che potrebbe essere di produzione
        setIsDeleteDialogOpen(false)
        await environmentQuery.refetch()
        setSelectedSlug(undefined)
        notifications.showSuccessNotification({
            message: t("environment.page.delete.success", { name: selected.name })
        })
    }

    return (
        <SinglePageLayout title={t("environment.page.title")} description={t("environment.page.description")}>
            <EnvironmentsGate
                onSaveSuccess={() => {
                    environmentQuery.refetch()
                }}
            >
                <ApiStatusHandler queries={[environmentQuery]}>
                    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <h2 className="text-xs font-semibold tracking-wide text-foreground-secondary uppercase">{t("environment.page.promotion_order")}</h2>
                        {canReorder && <p className="text-sm text-foreground-secondary">{t("environment.page.reorder.hint")}</p>}
                    </div>
                    {/* Da sinistra a destra nell'ordine di promozione; il dominio sta nell'intestazione dell'editor, non qui */}
                    <ol className="mb-6 flex flex-wrap items-center gap-2">
                        {orderedEnvironments.map((env, index) => {
                            const isSelected = env._id === selected?._id
                            return (
                                <li key={env._id} className="flex items-center gap-2">
                                    {index > 0 && <ArrowRight className="size-4 shrink-0 text-foreground-secondary" aria-hidden="true" />}
                                    <div
                                        data-testid={`environment-row-${env.slug}`}
                                        {...getItemProps(env._id)}
                                        className={cn(
                                            "relative rounded-lg",
                                            draggingId === env._id && "opacity-50",
                                            dragOverId === env._id && "outline-2 outline-offset-2 outline-dashed outline-primary"
                                        )}
                                    >
                                        <button
                                            type="button"
                                            onClick={() => requestSelection(env.slug)}
                                            aria-pressed={isSelected}
                                            data-testid={`environment-edit-${env.slug}`}
                                            className={cn(
                                                "flex items-center gap-2 rounded-lg border-2 border-border bg-card py-2 pl-3 text-left text-card-foreground transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                                                canReorder ? "pr-9" : "pr-3",
                                                isSelected && "border-primary bg-primary/10"
                                            )}
                                        >
                                            <ColorSwatch color={env.color} />
                                            <span className="font-medium">{env.name}</span>
                                            <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground-secondary">{env.slug}</span>
                                            {isGitOpsEnabled && env.kubeGreen?.enabled && (
                                                <img
                                                    src="/img/kube-green.svg"
                                                    alt={t("environment.form.kube_green.enabled_badge")}
                                                    title={t("environment.form.kube_green.enabled_badge")}
                                                    className="size-4 shrink-0"
                                                />
                                            )}
                                            {env.isProduction && <Badge variant="warning">{t("environment.production")}</Badge>}
                                        </button>
                                        {canReorder && (
                                            <span
                                                {...getHandleProps(env._id)}
                                                role="button"
                                                tabIndex={0}
                                                aria-label={t("environment.page.reorder.handle", { name: env.name })}
                                                title={t("environment.page.reorder.handle", { name: env.name })}
                                                className="absolute top-1/2 right-1.5 flex -translate-y-1/2 cursor-grab items-center justify-center rounded-md p-1 text-foreground-secondary hover:bg-primary/15 focus-visible:outline-2 focus-visible:outline-primary active:cursor-grabbing"
                                            >
                                                <GripVertical className="size-4" />
                                            </span>
                                        )}
                                    </div>
                                </li>
                            )
                        })}
                        <li>
                            <button
                                type="button"
                                onClick={() => requestSelection(NEW)}
                                aria-pressed={isCreating}
                                data-testid="environment-new"
                                className={cn(
                                    "flex items-center gap-2 rounded-lg border-2 border-dashed border-primary/40 px-4 py-2 text-sm font-medium text-primary-strong transition-colors hover:border-primary hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                                    isCreating && "border-solid border-primary bg-primary/10"
                                )}
                            >
                                <Plus className="size-4" aria-hidden="true" />
                                {t("environment.page.new_environment")}
                            </button>
                        </li>
                    </ol>

                    {isCreating && <EnvironmentEditor key={NEW} formData={draft} onSaved={onSaved} onCancel={() => setSelectedSlug(undefined)} onDirtyChange={setIsEditorDirty} />}
                    {selected && (
                        <EnvironmentEditor key={selected._id} id={selected._id} formData={selected} onSaved={onSaved} onDelete={() => setIsDeleteDialogOpen(true)} onDirtyChange={setIsEditorDirty} />
                    )}
                </ApiStatusHandler>
            </EnvironmentsGate>

            <Dialog open={pendingSelection !== undefined} onOpenChange={open => !open && setPendingSelection(undefined)}>
                <DialogContent closeLabel={t("common.close")} dataTestId="environment-unsaved-dialog">
                    <DialogHeader>
                        <DialogTitle>{t("environment.page.unsaved.title")}</DialogTitle>
                        <DialogDescription>{t("environment.page.unsaved.description")}</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button type="button" variant="secondary" onClick={() => setPendingSelection(undefined)}>
                            {t("environment.page.unsaved.keep")}
                        </Button>
                        <Button type="button" variant="destructive" onClick={discardAndSelect} dataTestId="environment-unsaved-discard">
                            {t("environment.page.unsaved.discard")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {selected?.isProduction ? (
                // Un ambiente di produzione serve utenti veri: per eliminarlo si ridigita il nome
                <ConfirmByTypingDialog
                    open={isDeleteDialogOpen}
                    onOpenChange={setIsDeleteDialogOpen}
                    expectedText={selected.name}
                    onConfirm={handleDelete}
                    title={t("environment.page.delete.title")}
                    warningTitle={t("environment.page.delete.production_warning")}
                    warningDescription={t("environment.page.delete.confirmation", { name: selected.name })}
                    confirmationHint={t("environment.page.delete.production_hint", { name: selected.name })}
                    confirmLabel={t("common.delete")}
                    confirmingLabel={t("common.deleting")}
                    cancelLabel={t("common.cancel")}
                    closeLabel={t("common.close")}
                    dataTestId="environment-delete-production-dialog"
                />
            ) : (
                <DeleteConfirmationDialog
                    isOpen={isDeleteDialogOpen}
                    onOpenChange={setIsDeleteDialogOpen}
                    onDelete={handleDelete}
                    title={t("environment.page.delete.title")}
                    description={t("environment.page.delete.confirmation", {
                        name: selected?.name || ""
                    })}
                />
            )}
        </SinglePageLayout>
    )
}
