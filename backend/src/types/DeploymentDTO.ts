export interface DeploymentDTO {
    environmentIds: string[]
    /** Deploys only the frontends and services of this functional domain: the others stay as served */
    domainId?: string
}
