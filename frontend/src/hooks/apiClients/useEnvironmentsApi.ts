import { AxiosError } from "axios"
import { useTranslation } from "react-i18next"
import useApiClient from "../useApiClient"
import { type EnvironmentDatabasesChoice, useDatabaseErrorTranslation } from "./useDatabaseApi"
import useGitOpsErrorMessage from "./useGitOpsErrorMessage"

/** Come per il backend (LOG_LEVELS): dal più verboso */
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const

export type LogLevel = (typeof LOG_LEVELS)[number]

/** Come per il backend (KubeGreenDay): un giorno della settimana, acceso da wakeUpAt a sleepAt oppure spento tutto il giorno */
export interface KubeGreenDay {
    /** Da 0 (domenica) a 6, come nel cron */
    weekday: number
    /** Se false resta spento tutto il giorno e gli orari non contano */
    awake: boolean
    /** HH:MM, nel fuso orario timeZone; se vuoto acceso da mezzanotte */
    wakeUpAt?: string
    /** HH:MM, nel fuso orario timeZone; se vuoto acceso fino a mezzanotte */
    sleepAt?: string
}

/** Come per il backend (KubeGreenSettings): quando kube-green spegne l'ambiente, con gli SleepInfo nel suo namespace */
export interface KubeGreenSettings {
    enabled: boolean
    /** Uno per giorno, dalla domenica: l'indice e' il giorno */
    days: KubeGreenDay[]
    timeZone: string
    suspendDeployments: boolean
    suspendStatefulSets: boolean
    suspendCronJobs: boolean
    /** Gli slug delle applicazioni che non si spengono mai */
    excludeApplications?: string[]
}

/** Come per il backend (KUBE_GREEN_DEFAULTS): acceso dalle 8 alle 20 dal lunedi' al venerdi', spento nel weekend */
export const KUBE_GREEN_DEFAULTS: KubeGreenSettings = {
    enabled: false,
    days: [0, 1, 2, 3, 4, 5, 6].map(weekday => (weekday >= 1 && weekday <= 5 ? { weekday, awake: true, wakeUpAt: "08:00", sleepAt: "20:00" } : { weekday, awake: false, wakeUpAt: "", sleepAt: "" })),
    timeZone: "Europe/Rome",
    suspendDeployments: true,
    suspendStatefulSets: true,
    suspendCronJobs: false,
    excludeApplications: []
}

export interface EnvironmentDTO {
    slug: string
    name: string
    description?: string
    order?: number
    createdAt?: string
    updatedAt?: string
    color?: string
    isProduction?: boolean
    domains?: string[]
    /** Namespace Kubernetes in cui GitOps fa il commit dell'ambiente; se vuoto e' lo slug in minuscolo */
    namespace?: string
    /** Sotto cosa e' esposto sul dominio del progetto, es. `dev`; se vuoto, sul dominio stesso */
    subdomain?: string
    /** Gli indirizzi e i range CIDR a cui risponde il suo host; se vuoto, tutti */
    ipAllowList?: string[]
    /** Il LOG_LEVEL dei suoi container */
    logLevel?: LogLevel
    /** Il LOG_JSON dei suoi container: log JSON invece che testo */
    logJson?: boolean
    kubeGreen?: KubeGreenSettings
    _id?: string
}

export interface CreateEnvironmentDTO {
    name: string
    slug: string
    isProduction?: boolean
    color?: string
    domains?: string[]
    namespace?: string
    subdomain?: string
    ipAllowList?: string[]
    logLevel?: LogLevel
    logJson?: boolean
    kubeGreen?: KubeGreenSettings
}

/** Un'applicazione con la versione che usa nell'ambiente di origine e in quello di destinazione di una promozione */
export interface PromotionRow {
    kind: "backend" | "frontend" | "maintenanceAgent"
    _id: string
    name: string
    slug: string
    from?: string
    to?: string
}

/** Un container che l'ambiente esegue, con i pod che vi esegue */
export interface ReplicasRow {
    kind: PromotionRow["kind"]
    _id: string
    name: string
    slug: string
    replicas: number
}

/** Se la promozione la cambia: un'applicazione che non gira nell'origine tiene quello che usa nella destinazione */
export const promotes = (row: PromotionRow) => Boolean(row.from) && row.from !== row.to

/** The refusals of a delete about the databases created on a MongoDB server that feed a resource in the environment */
const useEnvironmentDeleteErrorMessage = () => {
    const { t } = useTranslation()
    const translateDatabaseError = useDatabaseErrorTranslation()
    return (error: Error): string | undefined => {
        const response = (error as AxiosError<{ error?: { code?: string; message?: string; details?: { done?: string[]; failed?: string; reason?: string; code?: string } } }>)?.response
        const body = response?.data?.error
        // The limiter of a delete reaching the servers of its databases answers with no code of ours
        if (response?.status === 429 && !body?.code) return t("database.errors.rate_limited")
        switch (body?.code) {
            case "ENVIRONMENT_PROVISIONED_DATABASES_CHOICE_INVALID":
                return t("environment.page.delete.databases.errors.choice_invalid")
            case "ENVIRONMENT_HAS_PROVISIONED_DATABASES":
                return t("environment.page.delete.databases.errors.has_databases")
            case "ENVIRONMENT_DROP_CONFIRMATION_MISMATCH":
                return t("environment.page.delete.databases.errors.confirmation_mismatch")
            case "ENVIRONMENT_PROVISIONED_DATABASES_FAILED":
                return t("environment.page.delete.databases.errors.failed", {
                    failed: body.details?.failed,
                    // The refusal of that database, in the language of the user when it is one of ours
                    reason: translateDatabaseError(body.details?.code, body.details?.reason) ?? body.details?.reason,
                    done: body.details?.done?.length ? body.details.done.join(", ") : t("environment.page.delete.databases.errors.none_done")
                })
            default:
                return undefined
        }
    }
}

const useEnvironmentsApi = () => {
    const apiClient = useApiClient()
    // Creare, rinominare o eliminare un ambiente riallinea il repository GitOps, quando e' attivo
    const customErrorMessage = useGitOpsErrorMessage()
    const deleteErrorMessage = useEnvironmentDeleteErrorMessage()

    const getEnvironment = async (id: string) => {
        const response = await apiClient.doRequest<EnvironmentDTO>({
            url: `/api/environments/${id}`
        })
        return response.data
    }

    const createEnvironment = async (data: CreateEnvironmentDTO) => {
        const response = await apiClient.doRequest<EnvironmentDTO>({
            url: `/api/environments`,
            method: "POST",
            customErrorMessage,
            data
        })
        return response.data
    }

    const createEnvironmentsBulk = async (data: CreateEnvironmentDTO[]) => {
        const response = await apiClient.doRequest<EnvironmentDTO[]>({
            url: `/api/environments/bulk`,
            method: "POST",
            customErrorMessage,
            data
        })
        return response.data
    }

    /** `provisionedDatabases` says what becomes of the databases created on a MongoDB server that feed a resource there; a drop needs the name typed again */
    const deleteEnvironment = async (id: string, provisioned?: { provisionedDatabases: EnvironmentDatabasesChoice; confirmName?: string }) => {
        const response = await apiClient.doRequest({
            url: `/api/environments/${id}`,
            method: "DELETE",
            params: provisioned,
            customErrorMessage: (error: Error) => deleteErrorMessage(error) ?? customErrorMessage(error)
        })
        return response.data
    }

    /**
     * Persists the environments order: the position of each id inside the array becomes its order
     */
    const updateEnvironmentsOrder = async (ids: string[]) => {
        const response = await apiClient.doRequest<EnvironmentDTO[]>({
            url: `/api/environments/order`,
            method: "PUT",
            data: { ids }
        })
        return response.data
    }

    const editEnvironment = async (id: string, data: CreateEnvironmentDTO) => {
        const response = await apiClient.doRequest<EnvironmentDTO>({
            url: `/api/environments/${id}`,
            method: "PUT",
            customErrorMessage,
            data
        })
        return response.data
    }

    /** Le versioni di `fromId` accanto a quelle di `toId`: cosa cambierebbe una promozione */
    const getPromotion = async (toId: string, fromId: string) => {
        const response = await apiClient.doRequest<PromotionRow[]>({
            url: `/api/environments/${toId}/promotion?from=${encodeURIComponent(fromId)}`
        })
        return response.data
    }

    /** Porta in `toId` le versioni che le applicazioni scelte usano in `fromId`: le applica il prossimo deploy di `toId` */
    const promote = async (toId: string, fromId: string, applications: Pick<PromotionRow, "kind" | "_id">[]) => {
        const response = await apiClient.doRequest<PromotionRow[]>({
            url: `/api/environments/${toId}/promotion`,
            method: "POST",
            data: { from: fromId, applications }
        })
        return response.data
    }

    /** I container che `environmentId` esegue, con le repliche di ognuno lì */
    const getReplicas = async (environmentId: string) => {
        const response = await apiClient.doRequest<ReplicasRow[]>({ url: `/api/environments/${environmentId}/replicas` })
        return response.data
    }

    /** Mette a `replicas` i pod di ogni container che `environmentId` esegue: li applica il prossimo deploy */
    const setReplicas = async (environmentId: string, replicas: number) => {
        const response = await apiClient.doRequest<ReplicasRow[]>({
            url: `/api/environments/${environmentId}/replicas`,
            method: "POST",
            data: { replicas }
        })
        return response.data
    }

    /** L'indirizzo da cui il browser raggiunge la console, come lo vedrebbe la lista degli IP consentiti */
    const getClientIp = async () => {
        const response = await apiClient.doRequest<{ ip: string }>({ url: "/api/environments/client-ip" })
        return response.data.ip
    }

    return {
        createEnvironment,
        createEnvironmentsBulk,
        deleteEnvironment,
        editEnvironment,
        getClientIp,
        getEnvironment,
        getPromotion,
        getReplicas,
        promote,
        setReplicas,
        updateEnvironmentsOrder
    }
}

export default useEnvironmentsApi
