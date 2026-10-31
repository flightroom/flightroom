import { AddTile, ColorSwatch } from "@flightroom/design-system"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { GripVertical, Plus } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import SinglePageLayout from "@/components/SinglePageLayout"
import { DeleteConfirmationDialog } from "@/components/ui/DeleteConfirmationDialog"
import useEnvironmentsApi, { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import useProjectApi from "@/hooks/apiClients/useProjectApi"
import useDragAndDropOrder from "@/hooks/useDragAndDropOrder"
import { effectiveSubdomain } from "@/pages/backends/partials/backendVariables"
import useProjectStore from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import EnvironmentsGate from "@/theme/EnvironmentsGate"
import { cn } from "@/utils/styleUtils"
import EnvironmentEditor, { EnvironmentFormData, exposedHost } from "./partials/EnvironmentEditor"

/** Selezione della tessera "nuovo ambiente": l'editor si apre vuoto */
const NEW = "new"

const getRandomColor = () =>
    "#" +
    Math.floor(Math.random() * 16777215)
        .toString(16)
        .padStart(6, "0")

export default function EnvironmentsPage() {
    const { t } = useTranslation()

    const { deleteEnvironment, updateEnvironmentsOrder } = useEnvironmentsApi()
    const projectApi = useProjectApi()
    const notifications = useToastNotificationStore()
    const queryClient = useQueryClient()
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
    // Id dell'ambiente aperto nell'editor, NEW per la creazione; senza scelta vale il primo
    const [selectedId, setSelectedId] = useState<string>()
    const [draft, setDraft] = useState<EnvironmentFormData>()
    const [orderedEnvironments, setOrderedEnvironments] = useState<EnvironmentDTO[]>([])
    const { project, setEnvironments } = useProjectStore()
    const isGitOpsEnabled = Boolean(project?.gitOps?.enabled)
    const domain = project?.exposure?.domain
    // Senza dominio non c'e' ancora un host: si mostra almeno il sottodominio impostato
    const hostOf = (env: EnvironmentDTO) => (domain ? exposedHost(domain, effectiveSubdomain(env)) : env.subdomain || "-")

    const environmentQuery = useQuery({
        queryKey: ["environments", project._id],
        queryFn: () => projectApi.getEnvironmentsByProjectId(project._id)
    })

    useEffect(() => {
        setOrderedEnvironments(environmentQuery.data ?? [])
    }, [environmentQuery.data])

    const isCreating = selectedId === NEW && draft !== undefined
    const selected = isCreating ? undefined : (orderedEnvironments.find(env => env._id === selectedId) ?? orderedEnvironments[0])

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

    const onReorder = (environments: EnvironmentDTO[]) => {
        setOrderedEnvironments(environments)
        updateOrderMutation.mutate(environments)
    }

    const { draggingId, dragOverId, getHandleProps, getItemProps } = useDragAndDropOrder({
        items: orderedEnvironments,
        getId: env => env._id,
        onReorder,
        disabled: updateOrderMutation.isPending
    })

    const onSaved = async (environment: EnvironmentDTO) => {
        await environmentQuery.refetch()
        setSelectedId(environment._id)
    }

    const openCreate = () => {
        setDraft({
            name: "",
            slug: "",
            description: "",
            color: getRandomColor(),
            isProduction: false,
            logLevel: "info",
            logJson: true
        })
        setSelectedId(NEW)
    }

    const handleDelete = async () => {
        if (!selected?._id) return

        await deleteEnvironment(selected._id)
        await environmentQuery.refetch()
        setSelectedId(undefined)
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
                    <p className="mb-2 text-sm text-foreground-secondary">{t("environment.page.reorder.hint")}</p>
                    <div className="mb-6 grid grid-cols-[repeat(auto-fill,minmax(min(100%,200px),1fr))] gap-3">
                        {orderedEnvironments.map(env => {
                            const isSelected = env._id === selected?._id
                            return (
                                <div
                                    key={env._id}
                                    data-testid={`environment-row-${env.slug}`}
                                    {...getItemProps(env._id)}
                                    className={cn("relative rounded-lg", draggingId === env._id && "opacity-50", dragOverId === env._id && "outline-2 outline-offset-2 outline-dashed outline-primary")}
                                >
                                    <button
                                        type="button"
                                        onClick={() => setSelectedId(env._id)}
                                        aria-pressed={isSelected}
                                        data-testid={`environment-edit-${env.slug}`}
                                        className={cn(
                                            "flex h-full w-full flex-col items-start gap-1 rounded-lg border-2 border-border bg-card p-3 pr-10 text-left text-card-foreground transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                                            isSelected && "border-primary bg-primary/10"
                                        )}
                                    >
                                        <span className="flex w-full min-w-0 items-center gap-2">
                                            <ColorSwatch color={env.color} />
                                            <span className="truncate font-medium">{env.name}</span>
                                        </span>
                                        <span className="w-full truncate font-mono text-xs text-foreground-secondary">{env.slug}</span>
                                        {isGitOpsEnabled && <span className="w-full truncate font-mono text-xs text-foreground-secondary">{hostOf(env)}</span>}
                                        {env.isProduction && (
                                            <Badge variant="warning" className="mt-1">
                                                {t("environment.production")}
                                            </Badge>
                                        )}
                                    </button>
                                    <span
                                        {...getHandleProps(env._id)}
                                        role="button"
                                        tabIndex={0}
                                        aria-label={t("environment.page.reorder.handle", { name: env.name })}
                                        title={t("environment.page.reorder.handle", { name: env.name })}
                                        className="absolute top-2 right-2 flex cursor-grab items-center justify-center rounded-md p-1 text-foreground-secondary hover:bg-primary/15 focus-visible:outline-2 focus-visible:outline-primary active:cursor-grabbing"
                                    >
                                        <GripVertical className="size-4" />
                                    </span>
                                </div>
                            )
                        })}
                        <AddTile
                            aspect="auto"
                            onClick={openCreate}
                            icon={<Plus />}
                            label={t("environment.page.new_environment")}
                            aria-pressed={isCreating}
                            className={cn(isCreating && "border-primary bg-primary/10")}
                            dataTestId="environment-new"
                        />
                    </div>

                    {isCreating && <EnvironmentEditor key={NEW} formData={draft} onSaved={onSaved} onCancel={() => setSelectedId(undefined)} />}
                    {selected && <EnvironmentEditor key={selected._id} id={selected._id} formData={selected} onSaved={onSaved} onDelete={() => setIsDeleteDialogOpen(true)} />}
                </ApiStatusHandler>
            </EnvironmentsGate>

            <DeleteConfirmationDialog
                isOpen={isDeleteDialogOpen}
                onOpenChange={setIsDeleteDialogOpen}
                onDelete={handleDelete}
                title={t("environment.page.delete.title")}
                description={t("environment.page.delete.confirmation", {
                    name: selected?.name || ""
                })}
            />
        </SinglePageLayout>
    )
}
