import { BusinessException, createBusinessException } from "../../errors/BusinessException"
import { IArgoCdError } from "../../models/ProjectModel"
import { ArgoCdEnvironment } from "../gitops/argoCdManifests"
import { toErrorMessage } from "../RepositoryFileService"

/** What is stored of a failure: the code and the details translate on the screen, the message is for the rest */
export const errorOf = (error: unknown): IArgoCdError =>
    error instanceof BusinessException ? { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } : { message: toErrorMessage(error) }

export const nameClash = (name: string) =>
    createBusinessException({
        code: "ARGOCD_NAME_CLASH",
        message: `Two objects of this project would both be named ${name} in Argo CD: rename the backend, frontend or environment whose slugs join into it, then initialize again`,
        statusCode: 409,
        details: { name }
    })

export const reinitializeRequired = () =>
    createBusinessException({
        code: "ARGOCD_REINITIALIZE_REQUIRED",
        message: "Argo CD was initialized with other repositories, or its AppProject is not there: initialize it again to deploy the applications through it",
        statusCode: 409
    })

/** Environments a deploy committed to whose branch the applications repository does not list: Argo CD would read nothing there */
export const environmentsWithoutBranch = (environments: ArgoCdEnvironment[], repository: string, branches: string[]) =>
    createBusinessException({
        code: "ARGOCD_ENVIRONMENTS_WITHOUT_BRANCH",
        message: `${repository} lists no branch for ${environments.map(environment => environment.slug).join(", ")}, so Argo CD gets no Application there; the branches read are ${branches.join(", ") || "none"}`,
        statusCode: 409,
        details: { slug: environments.map(environment => environment.slug).join(", "), repository, name: branches.join(", ") }
    })

/** Environments added, or given another namespace, since the initialization: the AppProject does not let Argo CD write there yet */
export const namespacesNotInProject = (environments: ArgoCdEnvironment[]) =>
    createBusinessException({
        code: "ARGOCD_NAMESPACES_NOT_IN_PROJECT",
        message: `The namespaces of ${environments.map(environment => `${environment.slug} (${environment.namespace})`).join(", ")} are not in the AppProject yet: initialize Argo CD again to deploy those environments through it`,
        statusCode: 409,
        details: { slug: environments.map(environment => environment.slug).join(", ") }
    })

export const nameConflict = (kind: string, name: string) =>
    createBusinessException({
        code: "ARGOCD_NAME_CONFLICT",
        message: `Argo CD already has an ${kind} named ${name} that this project did not create, or one the account of the token may not read: rename or delete it in Argo CD, then initialize again`,
        statusCode: 409,
        details: { name }
    })

export const repositoryConflict = (repository: string) =>
    createBusinessException({
        code: "ARGOCD_REPOSITORY_CONFLICT",
        message: `Argo CD already has the repository ${repository} registered, by hand or by a project of another organization: remove that registration in Argo CD, then initialize again. One made by a project of this organization is shared on its own`,
        statusCode: 409,
        details: { repository }
    })

export const gitOpsRequired = () =>
    createBusinessException({
        code: "ARGOCD_GITOPS_REQUIRED",
        message: "Turn GitOps on and save its configuration repository before initializing Argo CD: that is what Argo CD deploys",
        statusCode: 422
    })

export const notConfigured = () =>
    createBusinessException({
        code: "ARGOCD_NOT_CONFIGURED",
        message: "The project deploys through no Argo CD: turn GitOps on with an applications repository and initialize Argo CD, then deploy the agent",
        statusCode: 422
    })

export const tokenRequired = () =>
    createBusinessException({
        code: "ARGOCD_TOKEN_REQUIRED",
        message: "Paste the API token of the Argo CD account: it is asked again whenever the URL changes, so the stored one never goes to another server"
    })

export const deployTokenFailed = (repository: string, error: unknown) =>
    createBusinessException({
        code: "ARGOCD_DEPLOY_TOKEN_FAILED",
        message: `GitLab did not create the deploy token of ${repository} (${toErrorMessage(error)}): the token of the connection needs the Maintainer role on the project and the api scope`,
        statusCode: 502,
        details: { repository, reason: toErrorMessage(error) }
    })

export const repositoryTokenRequired = (repository: string, provider: string) =>
    createBusinessException({
        code: "ARGOCD_REPOSITORY_TOKEN_REQUIRED",
        message: `Paste a read-only token Argo CD can clone ${repository} with: ${provider} cannot create one for it`,
        details: { repository, provider }
    })

export const branchesFailed = (repository: string, error: unknown) =>
    createBusinessException({
        code: "ARGOCD_BRANCHES_FAILED",
        message: `The branches of ${repository} could not be read (${toErrorMessage(error)}): the connection must reach the repository`,
        statusCode: 502,
        details: { repository, reason: toErrorMessage(error) }
    })
