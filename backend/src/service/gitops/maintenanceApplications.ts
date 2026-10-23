import Frontend, { FrontendKind } from "../../models/FrontendModel"
import { IMaintenanceAgent } from "../../models/MaintenanceAgentModel"
import Service from "../../models/ServiceModel"
import { GitOpsApplication, inClusterUrl, MaintainedTarget } from "./applicationManifests"

/**
 * The maintenance agents as the deploy writes their values: each with the services and frontends it maintains,
 * by slug, and the URL inside the environment of those that run as a container. A target deleted since is left out.
 */
export const maintenanceApplications = async (agents: IMaintenanceAgent[]): Promise<GitOpsApplication[]> => {
    if (agents.length === 0) return []
    const serviceIds = agents.flatMap(agent => agent.serviceIds ?? [])
    const frontendIds = agents.flatMap(agent => agent.frontendIds ?? [])
    const services = new Map((await Service.find({ _id: { $in: serviceIds } }, { slug: 1 })).map(service => [String(service._id), service.slug]))
    const frontends = new Map((await Frontend.find({ _id: { $in: frontendIds } }, { slug: 1, kind: 1 })).map(frontend => [String(frontend._id), frontend]))

    return agents.map(agent => {
        const targets: MaintainedTarget[] = [
            ...(agent.serviceIds ?? []).flatMap(id => {
                const slug = services.get(String(id))
                return slug ? [{ kind: "service" as const, slug, url: inClusterUrl(slug) }] : []
            }),
            ...(agent.frontendIds ?? []).flatMap(id => {
                const frontend = frontends.get(String(id))
                if (!frontend) return []
                return [{ kind: "frontend" as const, slug: frontend.slug, ...(frontend.kind === FrontendKind.DOCKER ? { url: inClusterUrl(frontend.slug) } : {}) }]
            })
        ]
        return {
            slug: agent.slug,
            version: agent.version,
            image: agent.image,
            port: agent.port,
            livenessPath: agent.livenessPath,
            readinessPath: agent.readinessPath,
            configMapIds: agent.configMapIds,
            secretIds: agent.secretIds,
            resourceIds: agent.resourceIds,
            maintenance: { kind: agent.kind, schedule: agent.schedule, timeZone: agent.timeZone, runPath: agent.runPath, targets }
        }
    })
}
