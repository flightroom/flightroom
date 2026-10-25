import type { DomainDeployments } from "@/hooks/apiClients/useDomainDeploymentsApi"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import { type Frontend, FrontendKind } from "@/hooks/apiClients/useFrontendsApi"
import type { ProjectExposure } from "@/hooks/apiClients/useProjectApi"
import { exposedOrigin } from "@/pages/backends/partials/backendVariables"

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

const previewUrlFor = (frontend: Frontend, frontends: Frontend[], origin: string) => {
    const container = servingContainers(frontend, frontends).find(candidate => candidate.exposurePath)
    return container?.exposurePath ? origin + container.exposurePath : undefined
}

const deployedEnvironments = (deployments: DomainDeployments) =>
    [...deployments.environments].sort((left, right) => Number(Boolean(right.environment.isProduction)) - Number(Boolean(left.environment.isProduction)))

/** The first deployed URL for this frontend, preferring production. */
export const frontendLivePreviewUrl = (
    frontend: Frontend,
    frontends: Frontend[],
    deployments: DomainDeployments | undefined,
    environments: EnvironmentDTO[],
    exposure: ProjectExposure | undefined
) => {
    if (!frontend._id || !deployments || !exposure?.domain) return undefined

    for (const entry of deployedEnvironments(deployments)) {
        if (!entry.frontends.some(deployed => deployed._id === frontend._id && deployed.version)) continue
        const environment = environments.find(candidate => candidate._id === entry.environment._id)
        if (!environment) continue
        const url = previewUrlFor(frontend, frontends, exposedOrigin(exposure, environment))
        if (url) return url
    }
    return undefined
}

/** The first deployed frontend URL in this domain, preferring production. */
export const domainLivePreviewUrl = (frontends: Frontend[], deployments: DomainDeployments | undefined, environments: EnvironmentDTO[], exposure: ProjectExposure | undefined) => {
    if (!deployments || !exposure?.domain) return undefined

    for (const entry of deployedEnvironments(deployments)) {
        const environment = environments.find(candidate => candidate._id === entry.environment._id)
        if (!environment) continue
        const origin = exposedOrigin(exposure, environment)
        for (const deployed of entry.frontends) {
            if (!deployed.version) continue
            const frontend = frontends.find(candidate => candidate._id === deployed._id)
            const url = frontend && previewUrlFor(frontend, frontends, origin)
            if (url) return url
        }
    }
    return undefined
}
