import useApiClient from "../useApiClient"

type LivePreviewTarget = { kind: "domain" | "frontend"; id: string }

const useLivePreviewsApi = () => {
    const apiClient = useApiClient()

    const start = async (target: LivePreviewTarget): Promise<string> => {
        const response = await apiClient.doRequest<{ url: string }, LivePreviewTarget>({
            url: "/api/live-previews",
            method: "POST",
            data: target,
            silent: true
        })
        return response.data.url
    }

    return { start }
}

export default useLivePreviewsApi
