import { Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmByTypingDialog, DangerZoneCard } from "@flightroom/design-system"
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Trash2, X } from "lucide-react"
import { useMemo, useState } from "react"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Link, useNavigate, useParams } from "react-router-dom"
import * as z from "zod"
import { Badge, Button } from "@/components/atoms"
import TextareaField from "@/components/input/TextareaField.rhf"
import TextField from "@/components/input/TextField.rhf"
import { ApiStatusHandler } from "@/components/organisms"
import SinglePageLayout from "@/components/SinglePageLayout"
import useBackendsApi from "@/hooks/apiClients/useBackendsApi"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import useFrontendsApi from "@/hooks/apiClients/useFrontendsApi"
import useVariableMapsApi, { VariableMap, VariableMapKind } from "@/hooks/apiClients/useVariableMapsApi"
import useProjectStore, { useIsProjectViewer } from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import { useProjectEnvironmentsQuery } from "../backends/partials/backendVariables"
import { useMaintenanceAgentsQuery } from "../maintenance-agents/partials/maintenance"
import VariableEntriesFields from "./partials/VariableEntriesFields"
import {
    ATTACHING_PATHS,
    type AttachingComponent,
    fromFormEntries,
    toFormEntries,
    useDetachVariableMap,
    VARIABLE_KEY,
    VARIABLE_MAP_FIELD,
    VARIABLE_MAP_KINDS,
    VARIABLE_MAP_NAME
} from "./partials/variableMaps"

const createFormSchema = (messages: { name: string; key: string; keyDuplicated: string }) =>
    z
        .object({
            name: z.string().trim().regex(VARIABLE_MAP_NAME, messages.name),
            // Same limit as the backend
            description: z.string().max(2000).optional(),
            entries: z.array(
                z.object({
                    key: z.string().trim().regex(VARIABLE_KEY, messages.key),
                    values: z.array(z.string()),
                    saved: z.boolean().default(false)
                })
            )
        })
        .superRefine((values, context) => {
            const seen = new Set<string>()
            values.entries.forEach((entry, index) => {
                if (seen.has(entry.key)) context.addIssue({ code: "custom", path: ["entries", index, "key"], message: messages.keyDuplicated })
                seen.add(entry.key)
            })
        })

type FormSchema = ReturnType<typeof createFormSchema>

/** Who receives the values of this map: each backend, DOCKER frontend or maintenance agent attaching it, linked */
const UsedBySection: React.FC<{ kind: VariableMapKind; map: VariableMap; attaching: AttachingComponent[] }> = ({ kind, map, attaching }) => {
    const { t } = useTranslation()
    const isViewer = useIsProjectViewer()
    const detach = useDetachVariableMap(kind)

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("variableMaps.used_by.title")}</CardTitle>
                <CardDescription>{t("variableMaps.used_by.description")}</CardDescription>
            </CardHeader>
            <CardContent className="pt-3">
                {attaching.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                        {attaching.map(component => (
                            <span key={component._id} className="inline-flex items-center">
                                <Link to={ATTACHING_PATHS[component.kind](component._id)}>
                                    <Badge variant="outline">{component.name}</Badge>
                                </Link>
                                {/* A viewer may look, not change what the containers receive */}
                                {!isViewer && (
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        disabled={detach.isPending}
                                        aria-label={t("variableMaps.used_by.detach", { name: component.name })}
                                        title={t("variableMaps.used_by.detach", { name: component.name })}
                                        onClick={() => detach.mutate({ component, map })}
                                    >
                                        <X />
                                    </Button>
                                )}
                            </span>
                        ))}
                    </div>
                ) : (
                    <p className="text-sm text-foreground-secondary">{t("variableMaps.used_by.none")}</p>
                )}
            </CardContent>
        </Card>
    )
}

const VariableMapDangerZone: React.FC<{ kind: VariableMapKind; map: VariableMap; inUse: boolean }> = ({ kind, map, inUse }) => {
    const { t } = useTranslation()
    const [opened, setOpened] = useState(false)
    const { deleteSingle } = useVariableMapsApi(kind)
    const notifications = useToastNotificationStore()
    const queryClient = useQueryClient()
    const navigate = useNavigate()

    const deleteMutation = useMutation({
        mutationFn: () => deleteSingle(map._id!),
        onSuccess: async () => {
            notifications.showSuccessNotification({ message: t("variableMaps.danger_zone.success") })
            await queryClient.invalidateQueries({ queryKey: ["variable-maps", kind] })
            navigate(VARIABLE_MAP_KINDS[kind].listPath)
        }
    })

    return (
        <DangerZoneCard
            title={t("variableMaps.danger_zone.title")}
            description={t("variableMaps.danger_zone.subtitle")}
            actionTitle={t("variableMaps.danger_zone.action_title")}
            // The backend refuses it too: the button only says so before the user tries
            actionDescription={inUse ? t("variableMaps.danger_zone.in_use") : t("variableMaps.danger_zone.action_description")}
            actionLabel={t("variableMaps.danger_zone.button")}
            actionIcon={<Trash2 />}
            disabled={inUse}
            onAction={() => setOpened(true)}
        >
            <ConfirmByTypingDialog
                open={opened}
                onOpenChange={setOpened}
                expectedText={map.name}
                onConfirm={async () => {
                    await deleteMutation.mutateAsync()
                }}
                isPending={deleteMutation.isPending}
                title={t("variableMaps.danger_zone.dialog.title")}
                warningTitle={t("variableMaps.danger_zone.dialog.warning")}
                warningDescription={t("variableMaps.danger_zone.dialog.description", { name: map.name })}
                confirmationHint={t("variableMaps.danger_zone.dialog.confirmation", { name: map.name })}
                placeholder={map.name}
                confirmLabel={t("variableMaps.danger_zone.button")}
                confirmingLabel={t("common.deleting")}
                cancelLabel={t("common.cancel")}
                closeLabel={t("common.close")}
            />
        </DangerZoneCard>
    )
}

interface VariableMapFormContentProps {
    kind: VariableMapKind
    environments: EnvironmentDTO[]
    attaching: AttachingComponent[]
    map?: VariableMap
}

const VariableMapFormContent: React.FC<VariableMapFormContentProps> = ({ kind, environments, attaching, map }) => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const notifications = useToastNotificationStore()
    const api = useVariableMapsApi(kind)
    const { listPath, detailPath, i18n: prefix } = VARIABLE_MAP_KINDS[kind]

    const formSchema = useMemo(
        () =>
            createFormSchema({
                name: t("variableMaps.name_invalid"),
                key: t("variableMaps.entries.key_invalid"),
                keyDuplicated: t("variableMaps.entries.key_duplicated")
            }),
        [t]
    )
    const form = useForm<z.input<FormSchema>, unknown, z.output<FormSchema>>({
        resolver: zodResolver(formSchema),
        defaultValues: {
            name: map?.name ?? "",
            description: map?.description ?? "",
            entries: toFormEntries(map?.entries, environments, kind === "secret")
        }
    })

    const onSubmit = async (data: z.output<FormSchema>) => {
        const dto = { name: data.name, description: data.description, entries: fromFormEntries(data.entries, environments) }
        if (map) {
            await api.update(map._id!, dto)
            notifications.showSuccessNotification({ message: t(`${prefix}.updated`) })
            await queryClient.invalidateQueries({ queryKey: ["variable-map", kind, map._id] })
        } else {
            const created = await api.create(dto)
            notifications.showSuccessNotification({ message: t(`${prefix}.created`) })
            navigate(detailPath(created._id!), { replace: true })
        }
        await queryClient.invalidateQueries({ queryKey: ["variable-maps", kind] })
    }

    return (
        <SinglePageLayout title={map ? map.name : t(`${prefix}.add_new`)} description={t(`${prefix}.form_description`)}>
            <FormProvider {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                    <Card>
                        <CardHeader>
                            <CardTitle className="mb-0">{t("variableMaps.general_information")}</CardTitle>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-2 pt-3">
                            <TextField
                                name="name"
                                label={t("variableMaps.name")}
                                placeholder={kind === "configMap" ? "orders-config" : "orders-database"}
                                description={t("variableMaps.name_hint")}
                                textTransform={value => value.toLowerCase().replace(/[^a-z0-9-]/g, "-")}
                                required
                            />
                            <TextareaField name="description" label={t("variableMaps.description")} placeholder={t("variableMaps.description_placeholder")} />
                        </CardContent>
                    </Card>

                    <VariableEntriesFields kind={kind} environments={environments} />

                    {map && <UsedBySection kind={kind} map={map} attaching={attaching} />}

                    {map && <VariableMapDangerZone kind={kind} map={map} inUse={attaching.length > 0} />}

                    <div className="flex justify-end gap-2">
                        <Button disabled={form.formState.isSubmitting} type="button" variant="secondary" onClick={() => navigate(listPath)}>
                            {t("common.cancel")}
                        </Button>
                        <Button disabled={form.formState.isSubmitting} type="submit">
                            {t("common.save")}
                        </Button>
                    </div>
                </form>
            </FormProvider>
        </SinglePageLayout>
    )
}

/** Creates a config map or a secret, or edits one: `/config-map/new`, `/config-map/:id` and the same under `/secret` */
const VariableMapForm: React.FC<{ kind: VariableMapKind }> = ({ kind }) => {
    const { id } = useParams<{ id: string }>()
    const isEdit = Boolean(id) && id !== "new"
    const projectId = useProjectStore(state => state.project?._id)
    const api = useVariableMapsApi(kind)
    const backendsApi = useBackendsApi()
    const frontendsApi = useFrontendsApi()

    const mapQuery = useQuery({ queryKey: ["variable-map", kind, id], queryFn: () => api.getSingle(id!), enabled: isEdit })
    const backendsQuery = useQuery({ queryKey: ["backends", projectId], queryFn: backendsApi.getAll, enabled: !!projectId })
    // Left out of the status handler: the backend refuses a delete they still block, the page need not wait for them
    const frontendsQuery = useQuery({ queryKey: ["frontends-by-project-id", projectId], queryFn: () => frontendsApi.getByProjectId(projectId!), enabled: isEdit && !!projectId })
    const agentsQuery = useMaintenanceAgentsQuery()
    // Before the form mounts: its default values hold one value per environment
    const environmentsQuery = useProjectEnvironmentsQuery()

    // The same three the backend counts before a delete
    const field = VARIABLE_MAP_FIELD[kind]
    const attaching: AttachingComponent[] = [
        ...(backendsQuery.data ?? []).map(component => ({ ...component, kind: "backend" as const })),
        ...(frontendsQuery.data ?? []).map(component => ({ ...component, kind: "frontend" as const })),
        ...(agentsQuery.data ?? []).map(component => ({ ...component, kind: "maintenanceAgent" as const }))
    ]
        .filter(component => !!id && component[field]?.includes(id))
        .map(({ kind: componentKind, _id, name }) => ({ kind: componentKind, _id: _id!, name }))

    return (
        <ApiStatusHandler queries={[mapQuery, backendsQuery, environmentsQuery]} interceptEmpty={false}>
            {/* Keyed: going from one map to another reuses the route, and the form must start over */}
            <VariableMapFormContent key={mapQuery.data?._id ?? "new"} kind={kind} environments={environmentsQuery.data ?? []} attaching={attaching} map={mapQuery.data} />
        </ApiStatusHandler>
    )
}

export default VariableMapForm
