import { Alert, AlertDescription, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmByTypingDialog, DangerZoneCard, SelectField } from "@flightroom/design-system"
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { GitBranch, KeyRound, Trash2, X } from "lucide-react"
import { useMemo, useState } from "react"
import { FormProvider, useForm, useWatch } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Link, useNavigate, useParams } from "react-router-dom"
import * as z from "zod"
import { Badge, Button } from "@/components/atoms"
import TextareaField from "@/components/input/TextareaField.rhf"
import TextField from "@/components/input/TextField.rhf"
import { ApiStatusHandler } from "@/components/organisms"
import ResourceIcon from "@/components/resource/ResourceIcon"
import { resourceIconUrl } from "@/components/resource/resourceIcons"
import SinglePageLayout from "@/components/SinglePageLayout"
import useBackendsApi, { Backend } from "@/hooks/apiClients/useBackendsApi"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import useResourcesApi, { Resource, ResourceDTO, ResourceTypeSpec } from "@/hooks/apiClients/useResourcesApi"
import useProjectStore, { useIsProjectViewer } from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import { useProjectEnvironmentsQuery } from "../backends/partials/backendVariables"
import ResourceApiSpecFields from "./partials/ResourceApiSpecFields"
import ResourceCustomFieldsEditor from "./partials/ResourceCustomFieldsEditor"
import ResourceFieldsTable from "./partials/ResourceFieldsTable"
import {
    byteLength,
    type CredentialToRetype,
    credentialsToRetype,
    fieldLabel,
    formatBytes,
    fromFormFields,
    MAX_API_SPEC_BYTES,
    MAX_RESOURCE_CUSTOM_FIELDS,
    RESOURCE_CUSTOM_FIELD_NAME,
    RESOURCE_ENV_PREFIX,
    RESOURCE_LIST_PATH,
    RESOURCE_NAME,
    type ResourceFormValues,
    resourceEnvKeys,
    resourceEnvPrefix,
    resourcePath,
    resourceVariant,
    toFormFields,
    toFormValues,
    typeDescription,
    typeLabel,
    useDetachResource,
    useResourceCatalogQuery,
    variantLabel,
    withVariantDefaults
} from "./partials/resources"

/** Same limits as the backend */
const MAX_VALUE_LENGTH = 32 * 1024
const MAX_DESCRIPTION_LENGTH = 2000
/** Come il contesto AI di progetto e domini */
const MAX_CONTEXT_LENGTH = 20_000
const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const isHttpUrl = (value: string) => {
    try {
        return ["http:", "https:"].includes(new URL(value).protocol)
    } catch {
        return false
    }
}

interface FormMessages {
    name: string
    envPrefix: string
    description: string
    context: string
    required: string
    port: string
    url: string
    email: string
    tooLong: string
    apiSpecTooLarge: string
    retype: string
    customFieldName: string
    customFieldDuplicated: string
}

const fieldValueSchema = z.object({ value: z.string(), saved: z.boolean() })

/**
 * The rules of the backend, said before saving: the catalog tells which field takes what. `initial`, the
 * resource as saved, tells the credentials a change of where it connects asks to type again.
 */
const createFormSchema = (catalog: ResourceTypeSpec[], environmentCount: number, messages: FormMessages, initial?: Pick<ResourceFormValues, "variant" | "fields">) =>
    z
        .object({
            name: z.string().trim().regex(RESOURCE_NAME, messages.name),
            description: z.string().max(MAX_DESCRIPTION_LENGTH, messages.description),
            context: z.string().max(MAX_CONTEXT_LENGTH, messages.context),
            type: z.string().min(1),
            variant: z.string().min(1),
            envPrefix: z
                .string()
                .trim()
                .refine(value => value === "" || RESOURCE_ENV_PREFIX.test(value), messages.envPrefix),
            customFields: z.array(z.object({ name: z.string().regex(RESOURCE_CUSTOM_FIELD_NAME, messages.customFieldName), secret: z.boolean() })).max(MAX_RESOURCE_CUSTOM_FIELDS),
            fields: z.record(z.string(), fieldValueSchema.extend({ overrides: z.array(fieldValueSchema) })),
            apiSpec: z.string().refine(value => byteLength(value) <= MAX_API_SPEC_BYTES, messages.apiSpecTooLarge),
            apiSpecRemoved: z.boolean()
        })
        .superRefine((values, context) => {
            const variant = resourceVariant(
                catalog.find(spec => spec.type === values.type),
                values.variant,
                values.customFields
            )
            // Each variable of a generic once: two of the same name would be one variable
            values.customFields.forEach((field, index) => {
                if (values.customFields.findIndex(other => other.name === field.name) < index) {
                    context.addIssue({ code: "custom", path: ["customFields", index, "name"], message: messages.customFieldDuplicated })
                }
            })
            for (const spec of variant?.fields ?? []) {
                const field = values.fields[spec.name]
                if (!field) continue
                const check = (value: string, path: (string | number)[]) => {
                    if (!value) return
                    let message: string | undefined
                    if (value.length > MAX_VALUE_LENGTH) message = messages.tooLong
                    else if (spec.input === "number" && !(/^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535)) message = messages.port
                    else if (spec.input === "url" && !isHttpUrl(value)) message = messages.url
                    else if (spec.input === "email" && !EMAIL_ADDRESS.test(value)) message = messages.email
                    if (message) context.addIssue({ code: "custom", path: ["fields", spec.name, ...path], message })
                }
                check(field.value, ["value"])
                field.overrides.forEach((override, index) => check(override.value, ["overrides", index, "value"]))
                // A credential may stay unset, as in a secret; any other required field needs a value in every environment
                const everywhere = Boolean(field.value) || (environmentCount > 0 && field.overrides.length === environmentCount && field.overrides.every(override => Boolean(override.value)))
                if (spec.required && !spec.secret && !everywhere) context.addIssue({ code: "custom", path: ["fields", spec.name, "value"], message: messages.required })
            }
            // A saved credential is not kept for a new address: blank no longer keeps it
            for (const { field, base, overrides } of initial ? credentialsToRetype(variant, initial.fields, values.fields, values.variant !== initial.variant) : []) {
                if (base) context.addIssue({ code: "custom", path: ["fields", field, "value"], message: messages.retype })
                for (const index of overrides) context.addIssue({ code: "custom", path: ["fields", field, "overrides", index, "value"], message: messages.retype })
            }
        })

type FormSchema = ReturnType<typeof createFormSchema>

/** Who receives the variables of this resource: each backend attaching it, linked */
const UsedBySection: React.FC<{ resource: Resource; backends: Backend[] }> = ({ resource, backends }) => {
    const { t } = useTranslation()
    const isViewer = useIsProjectViewer()
    const detach = useDetachResource()

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("resources.used_by.title")}</CardTitle>
                <CardDescription>{t("resources.used_by.description")}</CardDescription>
            </CardHeader>
            <CardContent className="pt-3">
                {backends.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                        {backends.map(backend => (
                            <span key={backend._id} className="inline-flex items-center">
                                <Link to={`/backend/${backend._id}`}>
                                    <Badge variant="outline">{backend.name}</Badge>
                                </Link>
                                {/* A viewer may look, not change what the backends receive */}
                                {!isViewer && (
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        disabled={detach.isPending}
                                        aria-label={t("resources.used_by.detach", { name: backend.name })}
                                        title={t("resources.used_by.detach", { name: backend.name })}
                                        onClick={() => detach.mutate({ backend, resource })}
                                    >
                                        <X />
                                    </Button>
                                )}
                            </span>
                        ))}
                    </div>
                ) : (
                    <p className="text-sm text-foreground-secondary">{t("resources.used_by.none")}</p>
                )}
            </CardContent>
        </Card>
    )
}

const ResourceDangerZone: React.FC<{ resource: Resource; inUse: boolean }> = ({ resource, inUse }) => {
    const { t } = useTranslation()
    const [opened, setOpened] = useState(false)
    const { deleteSingle } = useResourcesApi()
    const notifications = useToastNotificationStore()
    const queryClient = useQueryClient()
    const navigate = useNavigate()

    const deleteMutation = useMutation({
        mutationFn: () => deleteSingle(resource._id!),
        onSuccess: async () => {
            notifications.showSuccessNotification({ message: t("resources.danger_zone.success") })
            await queryClient.invalidateQueries({ queryKey: ["resources"] })
            navigate(RESOURCE_LIST_PATH)
        }
    })

    return (
        <DangerZoneCard
            title={t("resources.danger_zone.title")}
            description={t("resources.danger_zone.subtitle")}
            actionTitle={t("resources.danger_zone.action_title")}
            // The backend refuses it too: the button only says so before the user tries
            actionDescription={inUse ? t("resources.danger_zone.in_use") : t("resources.danger_zone.action_description")}
            actionLabel={t("resources.danger_zone.button")}
            actionIcon={<Trash2 />}
            disabled={inUse}
            onAction={() => setOpened(true)}
        >
            <ConfirmByTypingDialog
                open={opened}
                onOpenChange={setOpened}
                expectedText={resource.name}
                onConfirm={async () => {
                    await deleteMutation.mutateAsync()
                }}
                isPending={deleteMutation.isPending}
                title={t("resources.danger_zone.dialog.title")}
                warningTitle={t("resources.danger_zone.dialog.warning")}
                warningDescription={t("resources.danger_zone.dialog.description", { name: resource.name })}
                confirmationHint={t("resources.danger_zone.dialog.confirmation", { name: resource.name })}
                placeholder={resource.name}
                confirmLabel={t("resources.danger_zone.button")}
                confirmingLabel={t("common.deleting")}
                cancelLabel={t("common.cancel")}
                closeLabel={t("common.close")}
            />
        </DangerZoneCard>
    )
}

/** The credentials to type again, named with the environments they are to be typed in */
const RetypeAlert: React.FC<{ retype: CredentialToRetype[]; environments: EnvironmentDTO[] }> = ({ retype, environments }) => {
    const { t } = useTranslation()
    const where = ({ base, overrides }: CredentialToRetype) =>
        [...(base ? [t("resources.values.all_environments")] : []), ...overrides.map(index => environments[index]?.name ?? "")].filter(Boolean).join(", ")

    return (
        <Alert variant="warning">
            <KeyRound className="size-4" aria-hidden="true" />
            <AlertDescription>
                <p>{t("resources.retype.description")}</p>
                <ul className="mt-1 list-disc pl-5">
                    {retype.map(credential => (
                        <li key={credential.field}>
                            {fieldLabel(t, credential.field)} ({where(credential)})
                        </li>
                    ))}
                </ul>
            </AlertDescription>
        </Alert>
    )
}

/** The variables the resource sets, as they will be named: they follow the name, the prefix and the variant as they are typed */
const KeysPreview: React.FC<{ spec?: ResourceTypeSpec; variant: string; name: string; envPrefix: string }> = ({ spec, variant, name, envPrefix }) => {
    const { t } = useTranslation()
    const customFields = useWatch({ name: "customFields" }) as ResourceFormValues["customFields"] | undefined
    const keys = resourceEnvKeys(spec, variant, name, envPrefix.trim(), customFields)

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("resources.keys.title")}</CardTitle>
                <CardDescription>{t("resources.keys.description")}</CardDescription>
            </CardHeader>
            <CardContent className="pt-3">
                <ul className="flex flex-wrap gap-2">
                    {keys.map(key => (
                        <li key={key.key} className="flex items-center gap-1.5 rounded-md border border-divider px-2 py-1">
                            <code className="font-mono text-xs">
                                {key.key}
                                {key.value !== undefined && <span className="text-foreground-secondary">={key.value}</span>}
                            </code>
                            {key.secret && <Badge variant="outline">{t("resources.keys.secret")}</Badge>}
                            {key.value !== undefined && <Badge variant="outline">{t("resources.keys.fixed")}</Badge>}
                        </li>
                    ))}
                </ul>
            </CardContent>
        </Card>
    )
}

interface ResourceFormContentProps {
    catalog: ResourceTypeSpec[]
    environments: EnvironmentDTO[]
    backends: Backend[]
    resource?: Resource
}

const ResourceFormContent: React.FC<ResourceFormContentProps> = ({ catalog, environments, backends, resource }) => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const notifications = useToastNotificationStore()
    const api = useResourcesApi()
    const attaching = backends.filter(backend => resource?._id && backend.resourceIds?.includes(resource._id))
    const specOf = (type: string) => catalog.find(spec => spec.type === type)

    // The resource as saved: what a change of where it connects is told from
    const initial = useMemo(
        () =>
            resource &&
            toFormValues(
                catalog.find(spec => spec.type === resource.type),
                environments,
                resource
            ),
        [catalog, resource, environments]
    )
    const formSchema = useMemo(
        () =>
            createFormSchema(
                catalog,
                environments.length,
                {
                    name: t("resources.name_invalid"),
                    envPrefix: t("resources.env_prefix_invalid"),
                    description: t("resources.description_invalid"),
                    context: t("resources.context_invalid"),
                    required: t("resources.values.required"),
                    port: t("resources.values.port_invalid"),
                    url: t("resources.values.url_invalid"),
                    email: t("resources.values.email_invalid"),
                    tooLong: t("resources.values.too_long"),
                    apiSpecTooLarge: t("resources.api_spec.too_large", { max: formatBytes(MAX_API_SPEC_BYTES) }),
                    retype: t("resources.values.retype_required"),
                    customFieldName: t("resources.custom_fields.name_invalid"),
                    customFieldDuplicated: t("resources.custom_fields.name_duplicated")
                },
                initial
            ),
        [catalog, environments.length, t, initial]
    )
    const form = useForm<z.input<FormSchema>, unknown, z.output<FormSchema>>({
        resolver: zodResolver(formSchema),
        defaultValues: initial ?? toFormValues(specOf(catalog[0]?.type ?? ""), environments)
    })

    const [type, variant, name = "", envPrefix = ""] = useWatch({ control: form.control, name: ["type", "variant", "name", "envPrefix"] })
    const fields = useWatch({ control: form.control, name: "fields" }) as ResourceFormValues["fields"]
    const customFields = useWatch({ control: form.control, name: "customFields" }) as ResourceFormValues["customFields"]
    const spec = specOf(type)
    const variantSpec = resourceVariant(spec, variant, customFields)
    const retype = initial ? credentialsToRetype(variantSpec, initial.fields, fields ?? {}, variant !== initial.variant) : []

    // The engine of a database picks its logo, for every variant
    const engine = fields?.engine?.value || undefined
    const typeOptions = catalog.map(candidate => ({ value: candidate.type, label: typeLabel(t, candidate.type), icon: resourceIconUrl({ type: candidate.type }) }))
    const variantOptions = (spec?.variants ?? []).map(candidate => ({
        value: candidate.id,
        label: variantLabel(t, type, candidate.id),
        icon: resourceIconUrl({ type, variant: candidate.id, engine })
    }))

    // Another type has other fields: they start over from its defaults, on its first variant
    const onTypeChange = (next: string) => {
        const nextSpec = specOf(next)
        form.setValue("variant", nextSpec?.variants[0]?.id ?? "")
        form.setValue("customFields", [])
        form.setValue("fields", toFormFields(nextSpec, environments))
    }

    // Another variant has its own defaults: a value left blank or at the default of the previous one takes them
    const onVariantChange = (next: string) => {
        const nextVariant = spec?.variants.find(candidate => candidate.id === next)
        form.setValue("fields", withVariantDefaults(form.getValues("fields"), variantSpec, nextVariant), { shouldDirty: true })
    }

    const onSubmit = async (data: ResourceFormValues) => {
        const dto: ResourceDTO = {
            name: data.name,
            type: data.type,
            variant: data.variant,
            description: data.description,
            context: data.context,
            // Blank: the prefix derived from the type and the name
            envPrefix: data.envPrefix || null,
            // The backend refuses them on any other type
            ...(data.type === "generic" && { customFields: data.customFields }),
            fields: fromFormFields(resourceVariant(specOf(data.type), data.variant, data.customFields), data.fields, environments)
        }
        if (data.type === "api") {
            // Left out: the stored document stays
            if (data.apiSpec.trim()) dto.apiSpec = data.apiSpec
            else if (data.apiSpecRemoved) dto.apiSpec = null
        }
        if (resource) {
            const updated = await api.update(resource._id!, dto)
            notifications.showSuccessNotification({ message: t("resources.updated") })
            queryClient.setQueryData(["resource", resource._id], updated)
            // The credentials just typed are saved now: they come back as set, and the document as stored
            form.reset(toFormValues(specOf(updated.type), environments, updated))
        } else {
            const created = await api.create(dto)
            notifications.showSuccessNotification({ message: t("resources.created") })
            navigate(resourcePath(created._id!), { replace: true })
        }
        await queryClient.invalidateQueries({ queryKey: ["resources"] })
    }

    return (
        <SinglePageLayout
            title={resource ? resource.name : t("resources.add_new")}
            icon={type ? <ResourceIcon resource={{ type, variant, engine }} size={24} decorative /> : undefined}
            description={t("resources.form_description")}
        >
            <FormProvider {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                    <Card>
                        <CardHeader>
                            <CardTitle className="mb-0">{t("resources.general_information")}</CardTitle>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-2 pt-3">
                            <div className="flex flex-wrap gap-x-4 gap-y-2">
                                <SelectField
                                    name="type"
                                    label={t("resources.type")}
                                    options={typeOptions}
                                    disabled={Boolean(resource)}
                                    description={resource ? t("resources.type_locked") : typeDescription(t, type) || undefined}
                                    onValueChange={onTypeChange}
                                    containerClassName="flex-[1_1_240px]"
                                    className="w-full"
                                />
                                {variantOptions.length > 1 && (
                                    <SelectField
                                        name="variant"
                                        label={t("resources.variant")}
                                        options={variantOptions}
                                        description={t("resources.variant_hint")}
                                        onValueChange={onVariantChange}
                                        containerClassName="flex-[1_1_240px]"
                                        className="w-full"
                                    />
                                )}
                            </div>
                            <div className="flex flex-wrap gap-x-4 gap-y-2">
                                <TextField
                                    name="name"
                                    label={t("resources.name")}
                                    placeholder="orders-db"
                                    description={t("resources.name_hint")}
                                    textTransform={value => value.toLowerCase().replace(/[^a-z0-9-]/g, "-")}
                                    required
                                    containerClassName="flex-[1_1_240px]"
                                />
                                <TextField
                                    name="envPrefix"
                                    label={t("resources.env_prefix")}
                                    placeholder={resourceEnvPrefix(spec, name)}
                                    description={t("resources.env_prefix_hint")}
                                    textTransform={value => value.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}
                                    autoComplete="off"
                                    containerClassName="flex-[1_1_240px]"
                                />
                            </div>
                            <TextareaField name="description" label={t("resources.description")} placeholder={t("resources.description_placeholder")} />
                            <TextareaField
                                name="context"
                                maxLength={MAX_CONTEXT_LENGTH}
                                label={t("resources.context")}
                                placeholder={t("resources.context_placeholder")}
                                description={t("resources.context_hint")}
                                rows={8}
                                className="font-mono text-sm"
                                dataTestId="resource-context"
                            />
                        </CardContent>
                    </Card>

                    <KeysPreview spec={spec} variant={variant} name={name} envPrefix={envPrefix} />

                    {type === "generic" && <ResourceCustomFieldsEditor prefix={resourceEnvPrefix(spec, name, envPrefix.trim())} environmentCount={environments.length} />}

                    {retype.length > 0 && <RetypeAlert retype={retype} environments={environments} />}

                    <ResourceFieldsTable fields={variantSpec?.fields ?? []} prefix={resourceEnvPrefix(spec, name, envPrefix.trim())} environments={environments} retype={retype} />

                    {type === "api" && <ResourceApiSpecFields resource={resource} />}

                    <Alert>
                        <GitBranch className="size-4" aria-hidden="true" />
                        <AlertDescription>{t("resources.gitops_hint")}</AlertDescription>
                    </Alert>

                    {resource && <UsedBySection resource={resource} backends={attaching} />}

                    {resource && <ResourceDangerZone resource={resource} inUse={attaching.length > 0} />}

                    <div className="flex justify-end gap-2">
                        <Button disabled={form.formState.isSubmitting} type="button" variant="secondary" onClick={() => navigate(RESOURCE_LIST_PATH)}>
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

/** Creates a resource, or edits one: `/resource/new` and `/resource/:id` */
const ResourceForm: React.FC = () => {
    const { id } = useParams<{ id: string }>()
    const isEdit = Boolean(id) && id !== "new"
    const projectId = useProjectStore(state => state.project?._id)
    const api = useResourcesApi()
    const backendsApi = useBackendsApi()

    const resourceQuery = useQuery({ queryKey: ["resource", id], queryFn: () => api.getSingle(id!), enabled: isEdit })
    const backendsQuery = useQuery({ queryKey: ["backends", projectId], queryFn: backendsApi.getAll, enabled: !!projectId })
    const catalogQuery = useResourceCatalogQuery()
    // Before the form mounts: its default values hold one value per environment
    const environmentsQuery = useProjectEnvironmentsQuery()

    return (
        <ApiStatusHandler queries={[resourceQuery, backendsQuery, catalogQuery, environmentsQuery]} interceptEmpty={false}>
            {/* Keyed: going from one resource to another reuses the route, and the form must start over */}
            <ResourceFormContent
                key={resourceQuery.data?._id ?? "new"}
                catalog={catalogQuery.data ?? []}
                environments={environmentsQuery.data ?? []}
                backends={backendsQuery.data ?? []}
                resource={isEdit ? resourceQuery.data : undefined}
            />
        </ApiStatusHandler>
    )
}

export default ResourceForm
