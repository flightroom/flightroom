/** A config map holds values anyone who sees the project may read; a secret holds values never sent back once written */
export type VariableMapKind = "configMap" | "secret"

/** What a map is called: a Kubernetes object name (DNS label), so it can become one as it is */
export const VARIABLE_MAP_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/** A key with the value every environment gets and the ones an environment overrides it with; blank leaves it unset */
export interface VariableMapEntryDTO {
    key: string
    /** The value of every environment without one of its own */
    value?: string
    values?: Array<{ environmentId: string; value?: string }>
}

/** What a key is set to in one environment: its own value, the one of all otherwise; undefined leaves it unset there */
export const entryValueIn = (entry: { value?: string; values?: Array<{ environmentId: unknown; value?: string }> }, environmentId: string): string | undefined =>
    entry.values?.find(candidate => String(candidate.environmentId) === environmentId)?.value || entry.value || undefined

interface VariableMapDTO {
    id?: string
    name: string
    description?: string
    /** For a secret, a value sent as the placeholder the API answers with keeps the stored one */
    entries?: VariableMapEntryDTO[]
    createdAt?: Date
    updatedAt?: Date
}

export default VariableMapDTO
