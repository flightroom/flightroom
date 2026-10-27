import useApiClient from "../useApiClient"
import useGitOpsErrorMessage, { GitOpsErrorDetails } from "./useGitOpsErrorMessage"

export type ArgoCdRepositoryKind = "configuration" | "applications"

/** Come Argo CD legge un repository: deploy token creato dalla console (GitLab) o token incollato dall'owner */
export type ArgoCdCredentialSource = "deployToken" | "manual" | "shared"

export type ArgoCdRepositoryProvider = "GITHUB" | "GITLAB" | "AZURE_DEV_OPS"

/** Lo stato di Argo CD per il progetto: il backend non restituisce mai i token */
export interface ArgoCdStatus {
    url?: string
    /** URL e token salvati: il token si puo omettere alla prossima inizializzazione */
    configured: boolean
    /** Il certificato di Argo CD non viene verificato: per uno self-signed */
    insecure: boolean
    initializedAt?: string
    /** Per codice, da tradurre; il messaggio in inglese per cio che non ha un codice noto */
    lastError?: { code?: string; message: string; details?: GitOpsErrorDetails }
    alignError?: { code?: string; message: string; details?: GitOpsErrorDetails }
    repositories: Partial<Record<ArgoCdRepositoryKind, { source: ArgoCdCredentialSource }>>
    /** Almeno un repository non e' su GitLab: serve un token in sola lettura incollato a mano */
    needsRepositoryToken: boolean
    repositoryTokenProviders: ArgoCdRepositoryProvider[]
    /** Un token dei repository e' gia salvato: si puo omettere */
    repositoryTokenStored: boolean
    /** Owner del progetto o amministratore dell'organizzazione: gli altri vedono lo stato, non inizializzano */
    canInitialize: boolean
}

export interface ArgoCdInitializeDTO {
    url: string
    /** Assente = tiene quello salvato, solo se l'URL non cambia */
    token?: string
    repositoryToken?: string
    /** Accetta il certificato di Argo CD senza verificarlo, anche self-signed */
    insecure?: boolean
}

/** Un pod che l'Application di un backend, frontend o agente fa girare in un ambiente */
export interface ArgoCdPod {
    name: string
    namespace: string
    health?: string
    status?: string
    /** Container pronti sul totale, come "1/1" */
    containers?: string
    restarts?: number
    createdAt?: string
}

export interface ArgoCdLogLine {
    content: string
    timestamp?: string
}

export interface ArgoCdLogsQuery {
    pod: string
    tailLines: number
    /** I log del container prima dell'ultimo riavvio: quello che ha lasciato un crash */
    previous: boolean
    filter?: string
}

const useArgoCdApi = () => {
    const apiClient = useApiClient()
    const customErrorMessage = useGitOpsErrorMessage()

    const getArgoCd = async (projectId: string): Promise<ArgoCdStatus> => {
        const response = await apiClient.doRequest<ArgoCdStatus>({
            url: `/api/projects/${projectId}/argocd`
        })
        return response.data
    }

    const initializeArgoCd = async (projectId: string, data: ArgoCdInitializeDTO): Promise<ArgoCdStatus> => {
        const response = await apiClient.doRequest<ArgoCdStatus>({
            url: `/api/projects/${projectId}/argocd/initialize`,
            method: "POST",
            data,
            customErrorMessage
        })
        return response.data
    }

    const applicationUrl = (projectId: string, environmentId: string, slug: string) =>
        `/api/projects/${projectId}/argocd/environments/${encodeURIComponent(environmentId)}/applications/${encodeURIComponent(slug)}`

    /** Silenziose: l'errore lo mostra la sezione dei log, non un toast a ogni refresh */
    const getPods = async (projectId: string, environmentId: string, slug: string): Promise<ArgoCdPod[]> => {
        const response = await apiClient.doRequest<ArgoCdPod[]>({ url: `${applicationUrl(projectId, environmentId, slug)}/pods`, silent: true })
        return response.data
    }

    const getLogs = async (projectId: string, environmentId: string, slug: string, query: ArgoCdLogsQuery): Promise<ArgoCdLogLine[]> => {
        const params = new URLSearchParams({ pod: query.pod, tailLines: String(query.tailLines), previous: String(query.previous) })
        if (query.filter) params.set("filter", query.filter)
        const response = await apiClient.doRequest<ArgoCdLogLine[]>({ url: `${applicationUrl(projectId, environmentId, slug)}/logs?${params}`, silent: true })
        return response.data
    }

    return { getArgoCd, initializeArgoCd, getPods, getLogs }
}

export default useArgoCdApi
