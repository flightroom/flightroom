import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import useBackendsApi from "@/hooks/apiClients/useBackendsApi"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import useFrontendsApi from "@/hooks/apiClients/useFrontendsApi"
import useMaintenanceAgentsApi from "@/hooks/apiClients/useMaintenanceAgentsApi"
import useVariableMapsApi, { VariableMap, VariableMapEntry, VariableMapKind } from "@/hooks/apiClients/useVariableMapsApi"
import useProjectStore from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"

/** Same rule as the backend (BACKEND_VARIABLE_KEY): the key reaches the container as an environment variable name */
export const VARIABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/

/** Same rule as the backend (VARIABLE_MAP_NAME): a Kubernetes object name */
export const VARIABLE_MAP_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/** Where each kind lives in the console, and the prefix of its translations */
export const VARIABLE_MAP_KINDS: Record<VariableMapKind, { listPath: string; detailPath: (id: string) => string; i18n: string }> = {
    configMap: { listPath: "/config-maps", detailPath: id => `/config-map/${id}`, i18n: "variableMaps.configMap" },
    secret: { listPath: "/secrets", detailPath: id => `/secret/${id}`, i18n: "variableMaps.secret" }
}

/** The field of a backend, a DOCKER frontend or a maintenance agent that lists the maps of a kind it attaches */
export const VARIABLE_MAP_FIELD: Record<VariableMapKind, "configMapIds" | "secretIds"> = { configMap: "configMapIds", secret: "secretIds" }

/** What attaches a map, as the backend counts it before a delete: each one a container of its own */
export type AttachingKind = "backend" | "frontend" | "maintenanceAgent"

export interface AttachingComponent {
    kind: AttachingKind
    _id: string
    name: string
}

export const ATTACHING_PATHS: Record<AttachingKind, (id: string) => string> = {
    backend: id => `/backend/${id}`,
    frontend: id => `/frontend/${id}`,
    maintenanceAgent: id => `/maintenance-agent/${id}`
}

/**
 * A key as the form holds it: one value per environment of the project, in their order, so no
 * environment id ends up in a field path. `saved` marks a secret the backend already has: its values
 * are placeholders, which only mean something under the key they were sent with.
 */
export interface VariableEntryFormValue {
    key: string
    values: string[]
    saved: boolean
}

export const toFormEntries = (entries: VariableMapEntry[] | undefined, environments: EnvironmentDTO[], saved: boolean): VariableEntryFormValue[] =>
    (entries ?? []).map(entry => ({
        key: entry.key,
        values: environments.map(environment => entry.values.find(value => value.environmentId === environment._id)?.value ?? ""),
        saved
    }))

/** Blank values are left out: the key stays unset in that environment */
export const fromFormEntries = (entries: VariableEntryFormValue[], environments: EnvironmentDTO[]): VariableMapEntry[] =>
    entries.map(({ key, values }) => ({
        key,
        values: environments.flatMap((environment, index) => (values[index] && environment._id ? [{ environmentId: environment._id, value: values[index] }] : []))
    }))

/** The config maps or the secrets of the current project */
export const useVariableMapsQuery = (kind: VariableMapKind) => {
    const projectId = useProjectStore(state => state.project?._id)
    const { getAll } = useVariableMapsApi(kind)

    return useQuery({ queryKey: ["variable-maps", kind, projectId], queryFn: getAll, enabled: !!projectId })
}

type AttachedMaps = Partial<Record<"configMapIds" | "secretIds", string[]>>

/** Detaches a map from what attaches it: from the next deploy that container no longer receives its values */
export const useDetachVariableMap = (kind: VariableMapKind) => {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const notifications = useToastNotificationStore()
    const field = VARIABLE_MAP_FIELD[kind]
    const apis: Record<AttachingKind, { getSingle: (id: string) => Promise<AttachedMaps>; update: (id: string, fields: AttachedMaps) => Promise<unknown> }> = {
        backend: useBackendsApi(),
        frontend: useFrontendsApi(),
        maintenanceAgent: useMaintenanceAgentsApi()
    }

    return useMutation({
        mutationFn: async ({ component, map }: { component: AttachingComponent; map: Pick<VariableMap, "_id" | "name"> }) => {
            const api = apis[component.kind]
            // Read again: the list may predate another attach, which the PUT would otherwise drop
            const current = await api.getSingle(component._id)
            await api.update(component._id, { [field]: (current[field] ?? []).filter(id => id !== map._id) })
        },
        onSuccess: (_, { component, map }) => notifications.showSuccessNotification({ message: t("variableMaps.used_by.detached", { map: map.name, name: component.name }) }),
        onSettled: () => {
            for (const key of ["backend", "backends", "frontend", "frontends-by-project-id", "maintenance-agent", "maintenance-agents"]) {
                queryClient.invalidateQueries({ queryKey: [key] })
            }
        }
    })
}
