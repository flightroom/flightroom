import { KubeGreenSettings } from "./KubeGreen"

export interface EnvironmentDTO {
    name: string
    description: string
    slug: string
    order: number
    color: string
    isProduction: boolean
    domains: string[]
    namespace?: string
    subdomain?: string
    ipAllowList?: string[]
    /** trace, debug, info, warn, error or fatal: LOG_LEVEL of its containers */
    logLevel?: string
    /** LOG_JSON of its containers: JSON logs rather than plain text */
    logJson?: boolean
    /** The kube-green schedule, as a whole: it replaces the one saved */
    kubeGreen?: KubeGreenSettings
}

export interface EnvironmentOrderDTO {
    /** Environment ids sorted as they have to be displayed */
    ids: string[]
}
