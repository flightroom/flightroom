import { useMutation } from "@tanstack/react-query"
import useLivePreviewsApi from "@/hooks/apiClients/useLivePreviewsApi"

const useLivePreview = (target: { kind: "domain" | "frontend" | "backend"; id?: string }) => {
    const api = useLivePreviewsApi()
    const startMutation = useMutation({
        mutationFn: () => {
            if (!target.id) throw new Error(`The ${target.kind} id is unavailable`)
            return api.start({ kind: target.kind, id: target.id })
        }
    })

    return { start: startMutation.mutateAsync, isPending: startMutation.isPending }
}

export default useLivePreview
