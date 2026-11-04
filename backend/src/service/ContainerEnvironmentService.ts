import { isValidObjectId } from "mongoose"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import Backend from "../models/BackendModel"
import { IBackendEnvVariable } from "../models/ContainerFields"
import Environment from "../models/EnvironmentModel"
import Frontend, { FrontendKind } from "../models/FrontendModel"
import Project from "../models/ProjectModel"
import Resource from "../models/ResourceModel"
import { ConfigMap, IVariableMap, Secret } from "../models/VariableMapModel"
import { versionIn } from "../types/EnvironmentVersions"
import { resourceEnvironmentValues, resourceSecretName } from "../types/ResourceCatalog"
import { entryValueIn } from "../types/VariableMapDTO"
import { toObjectId } from "../utils/mongooseUtils"
import BaseAuthorizedService from "./BaseAuthorizedService"
import { environmentGateway } from "./GitOpsService"
import { ContainerVariable, containerEnvironment, containerPublicUrl, GitOpsApplication, gatewayOrigin, isDeployable, serviceUrls } from "./gitops/applicationManifests"

/** A value shown in clear is the team's configuration, not a document: past this it is cut */
const MAX_VALUE_CHARS = 2_000

/**
 * What the variables are, and so whether there are any:
 * - `next_deploy`: what the next deploy of the environment hands the container, from the configuration as it is now.
 *   The running pod has what the last deploy wrote: the same, unless the configuration changed since.
 * - `not_in_deploy`: the environment sets no version of it, or it has no image: a deploy leaves its values file as the
 *   last one wrote it, so a container may still run there with those values. None are listed.
 * - `no_gitops`: the project deploys no container through GitOps: no deploy of the console hands it variables.
 */
export type ContainerEnvironmentState = "next_deploy" | "not_in_deploy" | "no_gitops"

export interface ContainerEnvironmentDTO {
    state: ContainerEnvironmentState
    /** The version the environment runs, with `next_deploy` */
    version?: string
    variables: ContainerVariable[]
    /** The variables a DOCKER frontend declares that no source sets in the environment: none for a backend, whose own all have a value */
    missing: Array<Pick<IBackendEnvVariable, "name" | "required" | "secret">>
    /** What the answer leaves out, and why */
    notes?: string[]
}

/** What a map holds in one environment, by key: a key with no value there is left out, as the deploy leaves it out */
export const mapValues = (map: IVariableMap, environmentId: string): Record<string, string> =>
    Object.fromEntries(
        (map.entries ?? []).flatMap(entry => {
            const value = entryValueIn(entry, environmentId)
            return value === undefined ? [] : [[entry.key, value]]
        })
    )

const cut = (variable: ContainerVariable): ContainerVariable =>
    variable.value !== undefined && variable.value.length > MAX_VALUE_CHARS
        ? { ...variable, value: `${variable.value.slice(0, MAX_VALUE_CHARS)}… [cut at ${MAX_VALUE_CHARS} of ${variable.value.length} characters]` }
        : variable

/**
 * The environment variables the container of a backend or of a DOCKER frontend gets in one environment, built by
 * {@link containerEnvironment}, the function the deploy writes its values with: the two cannot tell different
 * stories. Read from the configuration as it is now, which reaches the pod with the next deploy. A Secret's value,
 * a resource's and a secret variable of the backend's included, never leaves here: only that it is set, and its length.
 */
class ContainerEnvironmentService extends BaseAuthorizedService {
    async get(projectId: string, target: { kind: "backend" | "frontend"; id: string }, environmentId: string): Promise<ContainerEnvironmentDTO> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        if (!isValidObjectId(target.id)) throw new EntityNotFoundError(target.id)
        if (!isValidObjectId(environmentId)) throw new EntityNotFoundError(environmentId)
        const component =
            target.kind === "backend"
                ? await Backend.findOne({ _id: toObjectId(target.id), projectId: projectIdObj })
                : await Frontend.findOne({ _id: toObjectId(target.id), projectId: projectIdObj, kind: FrontendKind.DOCKER })
        if (!component) throw new EntityNotFoundError(target.id)
        await this.ensureInDomainScope(projectIdObj, component.domainId)

        const [project, environments] = await Promise.all([
            Project.findById(projectIdObj, { slug: 1, exposure: 1, containerRegistry: 1, gitOps: 1 }),
            Environment.find({ projectId: projectIdObj }, { slug: 1, namespace: 1, subdomain: 1, isProduction: 1, ipAllowList: 1, logLevel: 1, logJson: 1 })
        ])
        const environment = environments.find(candidate => String(candidate._id) === environmentId)
        if (!project || !environment) throw new EntityNotFoundError(environmentId)
        const application: GitOpsApplication & { _id: unknown } = component
        // A deploy writes the values of the containers into the applications repository only: without it, nothing hands them variables
        const gitOps = project.gitOps
        if (!gitOps?.enabled || !gitOps.codeRepository || !gitOps.applicationsCodeRepository) return { state: "no_gitops", variables: [], missing: [] }
        const version = versionIn(application, environment._id)
        if (!version || !isDeployable(application, project.containerRegistry, environment._id)) return { state: "not_in_deploy", variables: [], missing: [] }

        const inProject = (ids: unknown[] | undefined) => ({ _id: { $in: (ids ?? []).map(id => toObjectId(String(id))) }, projectId: projectIdObj })
        // Read through the models, as the deploy reads them: a secret comes back decrypted, and only its length goes out
        const [configMaps, secrets, resources, backends, frontends] = await Promise.all([
            ConfigMap.find(inProject(application.configMapIds)),
            Secret.find(inProject(application.secretIds)),
            Resource.find(inProject(application.resourceIds)),
            // Every backend and DOCKER frontend of the project, as the deploy reads them for the URLs every container gets
            Backend.find({ projectId: projectIdObj }),
            Frontend.find({ projectId: projectIdObj, kind: FrontendKind.DOCKER })
        ])
        const id = String(environment._id)
        const notes: string[] = []
        // A host the deploy would refuse (an invalid subdomain, one two environments share) leaves PUBLIC_URL out, not the rest
        let origin: string | undefined
        try {
            origin = gatewayOrigin(environmentGateway(project, environment, environments))
        } catch (error) {
            notes.push(`PUBLIC_URL left out: ${error instanceof Error ? error.message : String(error)}`)
        }
        const variables = containerEnvironment(
            application,
            environment,
            {
                configMaps: new Map(configMaps.map(map => [String(map._id), map.name])),
                secrets: new Map(secrets.map(map => [String(map._id), map.name])),
                resources: new Map(resources.map(resource => [String(resource._id), resourceSecretName(resource)]))
            },
            {
                services: serviceUrls([...backends, ...frontends], environment._id, project.containerRegistry),
                configMaps: new Map(configMaps.map(map => [String(map._id), mapValues(map, id)])),
                secrets: new Map(secrets.map(map => [String(map._id), mapValues(map, id)])),
                resources: new Map(resources.map(resource => [String(resource._id), resourceEnvironmentValues(resource, id)]))
            },
            version,
            containerPublicUrl(target.kind, application, origin)
        )
        const set = new Set(variables.map(variable => variable.name))
        // Every variable of a backend comes with its value: only what a DOCKER frontend declares can be left unset
        const declared: IBackendEnvVariable[] = target.kind === "frontend" ? ((application.env ?? []) as IBackendEnvVariable[]) : []
        return {
            state: "next_deploy",
            version,
            variables: variables.map(cut),
            missing: declared.filter(variable => !set.has(variable.name)).map(({ name, required, secret }) => ({ name, required, secret })),
            ...(notes.length ? { notes } : {})
        }
    }
}

export default ContainerEnvironmentService
