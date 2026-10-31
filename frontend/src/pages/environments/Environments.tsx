import {
    ColorSwatch,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    SelectField,
    SwitchField as Switch,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    TextareaChipsField
} from "@flightroom/design-system"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, ExternalLink, GripVertical, Pencil, PlusCircle, Trash2, X } from "lucide-react"
import { useEffect, useState } from "react"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import ColorPicker from "@/components/input/ColorPicker.rhf"
import TextareaField from "@/components/input/TextareaField.rhf"
import TextField from "@/components/input/TextField.rhf"
import { ApiStatusHandler } from "@/components/organisms"
import SinglePageLayout from "@/components/SinglePageLayout"
import { DeleteConfirmationDialog } from "@/components/ui/DeleteConfirmationDialog"
import useEnvironmentsApi, { EnvironmentDTO, LOG_LEVELS, type LogLevel } from "@/hooks/apiClients/useEnvironmentsApi"
import useProjectApi from "@/hooks/apiClients/useProjectApi"
import useDragAndDropOrder from "@/hooks/useDragAndDropOrder"
import { effectiveSubdomain } from "@/pages/backends/partials/backendVariables"
import useProjectStore from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import EnvironmentsGate from "@/theme/EnvironmentsGate"
import { cn } from "@/utils/styleUtils"

interface EnvironmentDialogFormData {
    name: string
    slug: string
    description?: string
    color?: string
    isProduction?: boolean
    domains?: string[]
    namespace?: string
    subdomain?: string
    ipAllowList?: string[]
    logLevel?: LogLevel
    logJson?: boolean
}

/** Come per il backend: etichette DNS separate da punti, oppure niente per il dominio stesso */
const SUBDOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*)?$/

const IPV4 = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

/** Il parser degli URL del browser riconosce un IPv6 fra parentesi quadre: prima si scartano parentesi, zone e tutto ciò che chiuderebbe l'host */
const isIpv6 = (address: string) => {
    if (!address.includes(":") || !/^[0-9a-fA-F:.]+$/.test(address)) return false
    try {
        return new URL(`http://[${address}]`).hostname !== ""
    } catch {
        return false
    }
}

/** Come per il backend (isIpRange): un indirizzo IPv4 o IPv6, con o senza il prefisso CIDR */
const isIpRange = (value: string) => {
    const [address, prefix, ...rest] = value.split("/")
    const isV4 = IPV4.test(address)
    if ((!isV4 && !isIpv6(address)) || rest.length > 0) return false
    return prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= (isV4 ? 32 : 128))
}

/** Come per il backend (IP_ALLOW_LIST_MAX) */
const IP_ALLOW_LIST_MAX = 100

const exposedHost = (domain: string, subdomain: string) => (subdomain ? `${subdomain}.${domain}` : domain)

interface EnvironmentDialogProps {
    isOpen: boolean
    onOpenChange: (open: boolean) => void
    onSubmitSuccess?: () => Promise<void>
    formData: EnvironmentDialogFormData
    id?: string
}

function EnvironmentDialog({ isOpen, onOpenChange, onSubmitSuccess, formData, id }: EnvironmentDialogProps) {
    const { t } = useTranslation()
    const isEdit = Boolean(id)
    const form = useForm<EnvironmentDialogFormData>()
    const environemtnApi = useEnvironmentsApi()
    const notifications = useToastNotificationStore()
    // Il namespace serve solo a GitOps: senza, l'ambiente non finisce in nessun cluster
    const isGitOpsEnabled = Boolean(useProjectStore(state => state.project?.gitOps?.enabled))
    const slug = form.watch("slug")
    // Il sottodominio vale sul dominio del progetto: finche' non c'e', l'ambiente non e' esposto da GitOps
    const domain = useProjectStore(state => state.project?.exposure?.domain)
    const subdomain = form.watch("subdomain")
    const isProduction = form.watch("isProduction")

    const onSubmit = async (data: EnvironmentDialogFormData) => {
        if (isEdit) {
            await environemtnApi.editEnvironment(id, data)
            notifications.showSuccessNotification({
                message: t("environment.update_success")
            })
        } else {
            await environemtnApi.createEnvironment(data)
            notifications.showSuccessNotification({
                message: t("environment.create_success")
            })
        }

        await onSubmitSuccess?.()
    }

    useEffect(() => {
        if (!formData) {
            console.log("reset")
            form.reset({}, { keepValues: false, keepDirty: false })
        } else {
            form.reset(formData, { keepValues: false, keepDirty: false })
        }
    }, [formData, form.reset])

    return (
        <Dialog open={isOpen} onOpenChange={form.formState.isSubmitting ? undefined : onOpenChange}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{id ? t("environment.page.form.edit_title", { name: formData.name }) : t("environment.page.form.create_title")}</DialogTitle>
                </DialogHeader>
                <FormProvider {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                        <TextField
                            name="name"
                            dataTestId="environment-name"
                            label={t("environment.form.name")}
                            placeholder={t("environment.form.name_placeholder")}
                            rules={{
                                required: t("environment.form.name_required") as string
                            }}
                            required
                        />
                        <TextField
                            name="slug"
                            dataTestId="environment-slug"
                            label={t("environment.form.slug")}
                            placeholder={t("environment.form.slug_placeholder")}
                            rules={{
                                required: t("environment.form.slug_required") as string
                            }}
                            disabled={isEdit}
                            required
                        />
                        {isGitOpsEnabled && (
                            <TextField
                                name="namespace"
                                dataTestId="environment-namespace"
                                label={t("environment.form.namespace")}
                                placeholder={slug?.toLowerCase() || t("environment.form.namespace_placeholder")}
                                description={t("environment.form.namespace_description")}
                                rules={{
                                    pattern: {
                                        value: /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)?$/,
                                        message: t("environment.form.namespace_invalid")
                                    }
                                }}
                            />
                        )}
                        {isGitOpsEnabled && (
                            <TextField
                                name="subdomain"
                                dataTestId="environment-subdomain"
                                label={t("environment.form.subdomain")}
                                placeholder={t("environment.form.subdomain_placeholder")}
                                description={
                                    domain
                                        ? t("environment.form.subdomain_description", {
                                              host: exposedHost(domain, effectiveSubdomain({ slug: slug ?? "", subdomain: subdomain?.trim().toLowerCase(), isProduction }))
                                          })
                                        : t("environment.form.subdomain_description_no_domain")
                                }
                                // Il backend toglie gli spazi e porta in minuscolo: qui si controlla quello che salverà
                                rules={{ validate: value => SUBDOMAIN.test((value ?? "").trim().toLowerCase()) || t("environment.form.subdomain_invalid") }}
                            />
                        )}
                        {isGitOpsEnabled && (
                            <TextareaChipsField
                                name="ipAllowList"
                                dataTestId="environment-ip-allow-list"
                                label={t("environment.form.ip_allow_list")}
                                placeholder={t("environment.form.ip_allow_list_placeholder")}
                                description={domain ? t("environment.form.ip_allow_list_description") : t("environment.form.ip_allow_list_description_no_domain")}
                                textTransform={value => value.trim()}
                                rules={{
                                    validate: (ranges?: string[]) => {
                                        const invalid = ranges?.find(range => !isIpRange(range))
                                        if (invalid !== undefined) return t("environment.form.ip_allow_list_invalid", { value: invalid })
                                        return (ranges?.length ?? 0) <= IP_ALLOW_LIST_MAX || t("environment.form.ip_allow_list_too_long", { max: IP_ALLOW_LIST_MAX })
                                    }
                                }}
                            />
                        )}
                        {isGitOpsEnabled && (
                            <div className="flex flex-row flex-wrap items-start justify-between gap-4">
                                {/* SelectField non espone un test id: il wrapper dà ai test un aggancio stabile sul trigger. */}
                                <div data-testid="environment-log-level" className="flex-[1_1_200px]">
                                    <SelectField
                                        name="logLevel"
                                        label={t("environment.form.log_level")}
                                        description={t("environment.form.log_level_description")}
                                        options={LOG_LEVELS.map(level => ({ value: level, label: t(`environment.form.log_levels.${level}`) }))}
                                    />
                                </div>
                                <Switch name="logJson" label={t("environment.form.log_json")} description={t("environment.form.log_json_description")} />
                            </div>
                        )}
                        <TextareaField name="description" label={t("environment.form.description")} placeholder={t("environment.form.description_placeholder")} />
                        <TextareaChipsField name="domains" label={t("environment.form.domains")} placeholder={t("environment.form.domains_placeholder")} />
                        <div className="flex gap-4 flex-row justify-between">
                            <ColorPicker
                                name="color"
                                label={t("environment.color")}
                                rules={{
                                    required: t("environment.form.color_required") as string
                                }}
                                required
                            />
                            <Switch name="isProduction" label={t("environment.is_production")} />
                        </div>
                        <DialogFooter>
                            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={form.formState.isSubmitting}>
                                {t("environment.page.form.cancel")}
                            </Button>
                            <Button type="submit" disabled={form.formState.isSubmitting} dataTestId="environment-submit">
                                {id ? t("environment.page.form.update") : t("environment.page.form.create")}
                            </Button>
                        </DialogFooter>
                    </form>
                </FormProvider>
            </DialogContent>
        </Dialog>
    )
}

export default function EnvironmentsPage() {
    const { t } = useTranslation()

    const { deleteEnvironment, updateEnvironmentsOrder } = useEnvironmentsApi()
    const projectApi = useProjectApi()
    const notifications = useToastNotificationStore()
    const queryClient = useQueryClient()
    const [isDialogOpen, setIsDialogOpen] = useState(false)
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
    const [currentEnvironment, setCurrentEnvironment] = useState<EnvironmentDTO>()
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

    const onSubmitSuccess = async () => {
        await environmentQuery.refetch()
        setIsDialogOpen(false)
    }

    const handleEdit = (env: EnvironmentDTO) => {
        setCurrentEnvironment(env)
        setIsDialogOpen(true)
    }

    const getRandomColor = () => {
        return (
            "#" +
            Math.floor(Math.random() * 16777215)
                .toString(16)
                .padStart(6, "0")
        )
    }

    const openCreateDialog = () => {
        setCurrentEnvironment({
            name: "",
            slug: "",
            description: "",
            color: getRandomColor(),
            isProduction: false,
            logLevel: "info",
            logJson: true
        })
        setIsDialogOpen(true)
    }

    const handleDelete = async () => {
        if (!currentEnvironment?._id) return

        await deleteEnvironment(currentEnvironment._id)
        await environmentQuery.refetch()
        notifications.showSuccessNotification({
            message: t("environment.page.delete.success", { name: currentEnvironment.name })
        })
    }

    return (
        <SinglePageLayout
            title={t("environment.page.title")}
            description={t("environment.page.description")}
            right={
                !environmentQuery.isLoading && environmentQuery.data?.length != 0 ? (
                    <Button onClick={openCreateDialog} dataTestId="environment-new">
                        <PlusCircle />
                        {t("environment.page.new_environment")}
                    </Button>
                ) : null
            }
        >
            <EnvironmentsGate
                onSaveSuccess={() => {
                    environmentQuery.refetch()
                }}
            >
                <ApiStatusHandler queries={[environmentQuery]}>
                    <p className="mb-2 text-sm text-foreground-secondary">{t("environment.page.reorder.hint")}</p>
                    <Table framed>
                        <TableHeader>
                            <TableRow>
                                <TableHead className="w-10" />
                                <TableHead>{t("environment.form.name")}</TableHead>
                                <TableHead>{t("environment.form.slug")}</TableHead>
                                {isGitOpsEnabled && <TableHead>{domain ? t("environment.page.host") : t("environment.form.subdomain")}</TableHead>}
                                <TableHead>{t("environment.production")}</TableHead>
                                <TableHead>{t("environment.form.domains")}</TableHead>
                                <TableHead>{t("environment.page.color")}</TableHead>
                                <TableHead />
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {orderedEnvironments.map(env => (
                                <TableRow
                                    key={env._id}
                                    data-testid={`environment-row-${env.slug}`}
                                    {...getItemProps(env._id)}
                                    className={cn(draggingId === env._id && "opacity-50", dragOverId === env._id && "outline-2 -outline-offset-2 outline-dashed outline-primary")}
                                >
                                    <TableCell className="px-2">
                                        <span
                                            {...getHandleProps(env._id)}
                                            role="button"
                                            tabIndex={0}
                                            aria-label={t("environment.page.reorder.handle", { name: env.name })}
                                            title={t("environment.page.reorder.handle", { name: env.name })}
                                            className="flex cursor-grab items-center justify-center rounded-md p-1 text-foreground-secondary hover:bg-primary/15 focus-visible:outline-2 focus-visible:outline-primary active:cursor-grabbing"
                                        >
                                            <GripVertical className="size-4" />
                                        </span>
                                    </TableCell>
                                    <TableCell className="font-medium">{env.name}</TableCell>
                                    <TableCell>{env.slug}</TableCell>
                                    {isGitOpsEnabled && (
                                        <TableCell className="font-mono text-sm">
                                            {domain ? (
                                                <a
                                                    href={`https://${hostOf(env)}`}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="inline-flex items-center gap-1 text-primary-strong underline-offset-4 hover:underline"
                                                >
                                                    {hostOf(env)}
                                                    <ExternalLink className="size-3.5" aria-hidden="true" />
                                                    <span className="sr-only">{t("environment.page.opens_new_tab")}</span>
                                                </a>
                                            ) : (
                                                hostOf(env)
                                            )}
                                        </TableCell>
                                    )}
                                    <TableCell>{env.isProduction ? <Check /> : <X />}</TableCell>
                                    <TableCell>{env.domains?.join(", ") || "-"}</TableCell>
                                    <TableCell>
                                        <ColorSwatch size="lg" color={env.color} />
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex justify-end gap-1">
                                            <Button variant="ghost" size="icon" onClick={() => handleEdit(env)} dataTestId={`environment-edit-${env.slug}`}>
                                                <Pencil />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="text-destructive hover:bg-destructive/15 hover:text-destructive-active"
                                                onClick={() => {
                                                    setCurrentEnvironment(env)
                                                    setIsDeleteDialogOpen(true)
                                                }}
                                                dataTestId={`environment-delete-${env.slug}`}
                                            >
                                                <Trash2 />
                                            </Button>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </ApiStatusHandler>
            </EnvironmentsGate>

            {/* Create/Edit Dialog */}
            <EnvironmentDialog isOpen={isDialogOpen} onOpenChange={setIsDialogOpen} id={currentEnvironment?._id} onSubmitSuccess={onSubmitSuccess} formData={currentEnvironment} />

            {/* Delete Confirmation Dialog */}
            <DeleteConfirmationDialog
                isOpen={isDeleteDialogOpen}
                onOpenChange={setIsDeleteDialogOpen}
                onDelete={handleDelete}
                title={t("environment.page.delete.title")}
                description={t("environment.page.delete.confirmation", {
                    name: currentEnvironment?.name || ""
                })}
            />
        </SinglePageLayout>
    )
}
