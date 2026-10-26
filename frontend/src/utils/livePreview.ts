import type { AiJob } from "@/hooks/apiClients/useAiJobsApi"
import { type Frontend, FrontendKind } from "@/hooks/apiClients/useFrontendsApi"

/** The DOCKER frontends that serve a frontend: itself when it is one, else the first DOCKER up each line of its parents. */
export const servingContainers = (frontend: Frontend, frontends: Frontend[]): Frontend[] => {
    const byId = new Map(frontends.filter(candidate => candidate._id).map(candidate => [candidate._id!, candidate]))
    const found: Frontend[] = []
    const seen = new Set<string>()
    const visit = (current: Frontend) => {
        if (!current._id || seen.has(current._id)) return
        seen.add(current._id)
        if (current.kind === FrontendKind.DOCKER) {
            found.push(current)
            return
        }
        for (const parentId of current.parentIds ?? []) {
            const parent = byId.get(parentId)
            if (parent) visit(parent)
        }
    }
    visit(frontend)
    return found
}

/** The latest OpenShell frontend URL recorded in a conversation, optionally restricted to one repository. */
export const aiShellPreviewUrlFrom = (chain: AiJob[], frontendId?: string): string | undefined => {
    const frontendSlugs = new Set(
        chain
            .flatMap(job => job.repositories)
            .filter(repository => repository.kind === "frontend" && (!frontendId || repository.frontendId === frontendId))
            .map(repository => repository.frontendSlug)
    )
    let previewUrl: string | undefined

    for (const event of chain.flatMap(job => job.events ?? [])) {
        const match = /^preview-ready\|frontend\|([a-z0-9-]+)\|(.+)$/.exec(event.message)
        if (!match || !frontendSlugs.has(match[1])) continue
        try {
            const url = new URL(decodeURIComponent(match[2]))
            if (url.protocol === "http:" || url.protocol === "https:") previewUrl = url.toString()
        } catch {
            continue
        }
    }
    return previewUrl
}
