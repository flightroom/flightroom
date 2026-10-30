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
