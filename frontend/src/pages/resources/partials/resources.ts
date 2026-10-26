import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { TFunction } from "i18next"
import { useTranslation } from "react-i18next"
import useBackendsApi, { type Backend } from "@/hooks/apiClients/useBackendsApi"
import { SECRET_PLACEHOLDER } from "@/hooks/apiClients/useDatabaseApi"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import useResourcesApi, { Resource, ResourceCustomField, ResourceDTO, ResourceEnvKey, ResourceFieldSpec, ResourceTypeSpec, ResourceVariantSpec } from "@/hooks/apiClients/useResourcesApi"
import useProjectStore from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"

export { VARIABLE_MAP_NAME as RESOURCE_NAME } from "@/pages/variable-maps/partials/variableMaps"

/** Same rule as the backend (RESOURCE_ENV_PREFIX): what starts an environment variable name */
export const RESOURCE_ENV_PREFIX = /^[A-Z_][A-Z0-9_]{0,190}$/

/** Same rule and limit as the backend (RESOURCE_CUSTOM_FIELD_NAME, MAX_RESOURCE_CUSTOM_FIELDS): the end of a variable name */
export const RESOURCE_CUSTOM_FIELD_NAME = /^[A-Z0-9_]{1,61}$/
export const MAX_RESOURCE_CUSTOM_FIELDS = 100

/** Same limit as the backend (MAX_API_SPEC_BYTES) */
export const MAX_API_SPEC_BYTES = 5 * 1024 * 1024

export const RESOURCE_LIST_PATH = "/resources"
export const resourcePath = (id: string) => `/resource/${id}`

/** Mirror of the backend (resourceEnvPrefix): the prefix typed for the resource, otherwise the one of its type and its name */
export const resourceEnvPrefix = (spec: ResourceTypeSpec | undefined, name: string, envPrefix?: string | null): string =>
    envPrefix || [spec?.envPrefix, name.toUpperCase().replace(/-/g, "_")].filter(Boolean).join("_")

/** The fields a `generic` resource defines, as the catalog would give them; none for any other type */
const customFieldSpecs = (spec: ResourceTypeSpec | undefined, customFields?: ResourceCustomField[]): ResourceFieldSpec[] =>
    spec?.type === "generic" ? (customFields ?? []).map(({ name, secret }) => ({ name, envSuffix: name, secret, required: false, input: "text" })) : []

/** Mirror of the backend (resourceVariant): the variant of the type, with the fields a `generic` resource defines */
export const resourceVariant = (spec: ResourceTypeSpec | undefined, variantId: string, customFields?: ResourceCustomField[]): ResourceVariantSpec | undefined => {
    const variant = spec?.variants.find(candidate => candidate.id === variantId)
    const custom = customFieldSpecs(spec, customFields)
    return variant && custom.length > 0 ? { ...variant, fields: [...variant.fields, ...custom] } : variant
}

/** Mirror of the backend (resourceEnvKeys): every variable the variant sets, whether its field has a value or not */
export const resourceEnvKeys = (spec: ResourceTypeSpec | undefined, variantId: string, name: string, envPrefix?: string | null, customFields?: ResourceCustomField[]): ResourceEnvKey[] => {
    const variant = resourceVariant(spec, variantId, customFields)
    if (!variant) return []
    const prefix = resourceEnvPrefix(spec, name, envPrefix)
    return [
        ...variant.fields.map(({ name: field, envSuffix, secret, required }) => ({ key: `${prefix}_${envSuffix}`, field, secret, required })),
        ...Object.entries(variant.fixed ?? {}).map(([envSuffix, value]) => ({ key: `${prefix}_${envSuffix}`, secret: false, required: true, value }))
    ]
}

/** The labels of the catalog, falling back to the raw id: a type added to the backend shows before it is translated */
export const typeLabel = (t: TFunction, type: string) => t(`resources.types.${type}.label`, { defaultValue: type })
export const typeDescription = (t: TFunction, type: string) => t(`resources.types.${type}.description`, { defaultValue: "" })
export const variantLabel = (t: TFunction, type: string, variant: string) => t(`resources.variants.${type}.${variant}`, { defaultValue: variant })
export const fieldLabel = (t: TFunction, field: string) => t(`resources.fields.${field}`, { defaultValue: field })
export const optionLabel = (t: TFunction, field: string, option: string) =>
    field === "engine" ? t(`database.types.${option}`, { defaultValue: option }) : t(`resources.options.${field}.${option}`, { defaultValue: option })

/**
 * A field as the form holds it: its value for all environments and one per environment of the project, in
 * their order, so no environment id ends up in a field path. `saved` marks a credential the backend already
 * has there: left blank it keeps it, and clearing the mark is how it is removed.
 */
export interface ResourceFieldFormValue {
    value: string
    saved: boolean
    overrides: Array<{ value: string; saved: boolean }>
}

export interface ResourceFormValues {
    name: string
    description: string
    context: string
    type: string
    variant: string
    envPrefix: string
    /** A `generic` only: the variables it defines, whose values are in `fields` by name */
    customFields: ResourceCustomField[]
    fields: Record<string, ResourceFieldFormValue>
    /** An `api` only: a document typed or loaded here; blank keeps the stored one */
    apiSpec: string
    /** An `api` only: the stored document goes on save */
    apiSpecRemoved: boolean
}

/** Every field of the type, by name across its variants: switching variant keeps what the two share. A `generic` adds those it defines */
export const typeFields = (spec: ResourceTypeSpec | undefined, customFields?: ResourceCustomField[]): ResourceFieldSpec[] => {
    const byName = new Map<string, ResourceFieldSpec>()
    for (const variant of spec?.variants ?? []) for (const field of variant.fields) if (!byName.has(field.name)) byName.set(field.name, field)
    for (const field of customFieldSpecs(spec, customFields)) if (!byName.has(field.name)) byName.set(field.name, field)
    return [...byName.values()]
}

/** A field with no value anywhere: a variable of a `generic` just added, renamed, or turned secret or plain */
export const emptyFormField = (environmentCount: number): ResourceFieldFormValue => ({
    value: "",
    saved: false,
    overrides: Array.from({ length: environmentCount }, () => ({ value: "", saved: false }))
})

/** The default a variant gives a field: two variants sharing a field may not share its default (the model of an ai) */
export const variantDefault = (variant: ResourceVariantSpec | undefined, field: string): string => variant?.fields.find(candidate => candidate.name === field)?.default ?? ""

/**
 * The fields of the form for a resource of `spec`. A field the resource has comes with its values; one of
 * its variant it does not have stays blank, as it is unset; any other (of another variant, or of a new
 * resource) starts with the default `variantId` gives it, the first variant's for a new resource.
 */
export const toFormFields = (spec: ResourceTypeSpec | undefined, environments: EnvironmentDTO[], resource?: Resource, variantId?: string): Record<string, ResourceFieldFormValue> => {
    const variant = resource && resourceVariant(spec, resource.variant, resource.customFields)
    const defaults = spec?.variants.find(candidate => candidate.id === (variantId ?? resource?.variant)) ?? spec?.variants[0]
    return Object.fromEntries(
        typeFields(spec, resource?.customFields).map(field => {
            const stored = resource?.fields[field.name]
            const unset = Boolean(variant?.fields.some(candidate => candidate.name === field.name))
            const base = stored?.value ?? (unset ? "" : variantDefault(defaults, field.name))
            return [
                field.name,
                {
                    // A credential is never typed back: the placeholder only says it is there
                    value: field.secret ? "" : base,
                    saved: field.secret && Boolean(stored?.value),
                    overrides: environments.map(environment => {
                        const override = stored?.overrides.find(candidate => candidate.environmentId === environment._id)?.value
                        return { value: field.secret ? "" : (override ?? ""), saved: field.secret && Boolean(override) }
                    })
                }
            ]
        })
    )
}

export const toFormValues = (spec: ResourceTypeSpec | undefined, environments: EnvironmentDTO[], resource?: Resource): ResourceFormValues => ({
    name: resource?.name ?? "",
    description: resource?.description ?? "",
    context: resource?.context ?? "",
    type: resource?.type ?? spec?.type ?? "",
    variant: resource?.variant ?? spec?.variants[0]?.id ?? "",
    envPrefix: resource?.envPrefix ?? "",
    customFields: resource?.customFields ?? [],
    fields: toFormFields(spec, environments, resource),
    apiSpec: "",
    apiSpecRemoved: false
})

/**
 * The fields of the form once the variant goes from `previous` to `next`: a value left blank, or still the
 * default of the previous variant, takes the default of the next one (the model of an ai goes from Claude's
 * to none for OpenAI); a value typed stays.
 */
export const withVariantDefaults = (
    fields: Record<string, ResourceFieldFormValue>,
    previous: ResourceVariantSpec | undefined,
    next: ResourceVariantSpec | undefined
): Record<string, ResourceFieldFormValue> =>
    Object.fromEntries(
        Object.entries(fields).map(([name, field]) => {
            const untouched = !field.value || field.value === variantDefault(previous, name)
            return [name, untouched ? { ...field, value: variantDefault(next, name) } : field]
        })
    )

/** A credential the form must have typed again: in all environments (`base`) and in the environments at these indexes */
export interface CredentialToRetype {
    field: string
    base: boolean
    overrides: number[]
}

/**
 * Mirror of the backend (normalizeResourceFields): the credentials kept as saved that must be typed again
 * because where the resource connects changed since `initial`. A change of variant, or of the value of all of
 * a connection field, asks for every one kept; a change of the override of a connection field in one
 * environment asks for the value each credential takes there, its override if it has one, its value of all
 * otherwise.
 */
export const credentialsToRetype = (
    variant: ResourceVariantSpec | undefined,
    initial: Record<string, ResourceFieldFormValue>,
    current: Record<string, ResourceFieldFormValue>,
    variantChanged: boolean
): CredentialToRetype[] => {
    let everywhere = variantChanged
    const environments = new Set<number>()
    for (const spec of variant?.fields ?? []) {
        if (!spec.connection) continue
        const before = initial[spec.name]
        const after = current[spec.name]
        if ((before?.value ?? "") !== (after?.value ?? "")) everywhere = true
        const count = Math.max(before?.overrides.length ?? 0, after?.overrides.length ?? 0)
        for (let index = 0; index < count; index++) {
            if ((before?.overrides[index]?.value ?? "") !== (after?.overrides[index]?.value ?? "")) environments.add(index)
        }
    }
    if (!everywhere && environments.size === 0) return []
    return (variant?.fields ?? []).flatMap(spec => {
        const field = current[spec.name]
        if (!spec.secret || !field) return []
        const kept = (value?: { value: string; saved: boolean }) => Boolean(value?.saved && !value.value)
        const overridden = (index: number) => Boolean(field.overrides[index]?.saved || field.overrides[index]?.value)
        const base = kept(field) && (everywhere || [...environments].some(index => !overridden(index)))
        const overrides = field.overrides.flatMap((override, index) => (kept(override) && (everywhere || environments.has(index)) ? [index] : []))
        return base || overrides.length > 0 ? [{ field: spec.name, base, overrides }] : []
    })
}

/** What a value of the form sends: typed, the placeholder that keeps a saved credential, or blank to unset it */
const sentValue = (secret: boolean, { value, saved }: { value: string; saved: boolean }) => (value ? value : secret && saved ? SECRET_PLACEHOLDER : "")

/** Only the fields of the variant: the backend drops the others on a change of variant */
export const fromFormFields = (variant: ResourceVariantSpec | undefined, fields: Record<string, ResourceFieldFormValue>, environments: EnvironmentDTO[]): NonNullable<ResourceDTO["fields"]> =>
    Object.fromEntries(
        (variant?.fields ?? []).map(field => {
            const current = fields[field.name] ?? { value: "", saved: false, overrides: [] }
            return [
                field.name,
                {
                    value: sentValue(field.secret, current),
                    overrides: environments.flatMap((environment, index) => {
                        const value = current.overrides[index] ? sentValue(field.secret, current.overrides[index]) : ""
                        return value && environment._id ? [{ environmentId: environment._id, value }] : []
                    })
                }
            ]
        })
    )

/** The UTF-8 size of a text, as the backend counts it */
export const byteLength = (text: string) => new Blob([text]).size

/** A size in bytes the way a person reads it */
export const formatBytes = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`)

/** The resources of the current project */
export const useResourcesQuery = (enabled = true) => {
    const projectId = useProjectStore(state => state.project?._id)
    const { getAll } = useResourcesApi()

    return useQuery({ queryKey: ["resources", projectId], queryFn: getAll, enabled: !!projectId && enabled })
}

/** The types a resource can be: fixed for a running backend */
export const useResourceCatalogQuery = () => {
    const { getCatalog } = useResourcesApi()

    return useQuery({ queryKey: ["resource-catalog"], queryFn: getCatalog, staleTime: Infinity })
}

/** Detaches a resource from a backend: from the next deploy it no longer receives its variables */
export const useDetachResource = () => {
    const { t } = useTranslation()
    const backendsApi = useBackendsApi()
    const queryClient = useQueryClient()
    const notifications = useToastNotificationStore()

    return useMutation({
        mutationFn: async ({ backend, resource }: { backend: Pick<Backend, "_id" | "name">; resource: Pick<Resource, "_id" | "name"> }) => {
            // Read again: the list may predate another attach, which the PUT would otherwise drop
            const current = await backendsApi.getSingle(backend._id!)
            await backendsApi.update(backend._id!, { resourceIds: (current.resourceIds ?? []).filter(id => id !== resource._id) })
        },
        onSuccess: (_, { backend, resource }) => notifications.showSuccessNotification({ message: t("resources.attach.detached", { resource: resource.name, backend: backend.name }) }),
        onSettled: (_, __, { backend }) => {
            queryClient.invalidateQueries({ queryKey: ["backend", backend._id] })
            queryClient.invalidateQueries({ queryKey: ["backends"] })
        }
    })
}
