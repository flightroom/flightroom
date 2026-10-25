import { useMutation } from "@tanstack/react-query"
import useLivePreviewsApi from "@/hooks/apiClients/useLivePreviewsApi"

const useLivePreview = (target: { kind: "domain"; id: string } | { kind: "frontend"; id?: string }) => {
    const api = useLivePreviewsApi()
    const startMutation = useMutation({
        mutationFn: () => {
            if (target.kind === "domain") return api.start(target)
            if (!target.id) throw new Error("The frontend id is unavailable")
            return api.start({ kind: "frontend", id: target.id })
        }
    })

    return { start: startMutation.mutateAsync, isPending: startMutation.isPending }
}

export default useLivePreview
