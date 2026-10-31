import useApiClient from "../useApiClient"
import useGitOpsErrorMessage from "./useGitOpsErrorMessage"

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

const useEnvironmentsApi = () => {
    const apiClient = useApiClient()
    // Creare, rinominare o eliminare un ambiente riallinea il repository GitOps, quando e' attivo
    const customErrorMessage = useGitOpsErrorMessage()

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

    const deleteEnvironment = async (id: string) => {
        const response = await apiClient.doRequest({
            url: `/api/environments/${id}`,
            method: "DELETE",
            customErrorMessage
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

    return {
        createEnvironment,
        createEnvironmentsBulk,
        deleteEnvironment,
        editEnvironment,
        getEnvironment,
        getPromotion,
        getReplicas,
        promote,
        setReplicas,
        updateEnvironmentsOrder
    }
}

export default useEnvironmentsApi
