export interface DeploymentDTO {
    environmentIds: string[]
    /** Deploys only the frontends and backends of this functional domain: the others stay as served */
    domainId?: string
}
