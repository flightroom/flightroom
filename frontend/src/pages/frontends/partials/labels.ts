import { CanaryDeploymentType, CanaryType, FrontendKind, HostedOn } from "@/hooks/apiClients/useFrontendsApi"

/** Translation keys shared by every frontend view, so the label of a value is spelled out in one place only. */

export const HOST_TYPE_LABEL_KEYS: Record<HostedOn, string> = {
    [HostedOn.MFE_ORCHESTRATOR_HUB]: "frontend.hostTypes.mfeOrchestratorHub",
    [HostedOn.CUSTOM_URL]: "frontend.hostTypes.customUrl",
    [HostedOn.CUSTOM_SOURCE]: "frontend.hostTypes.customSource"
}

export const CANARY_TYPE_LABEL_KEYS: Record<CanaryType, string> = {
    [CanaryType.RANDOM]: "frontend.randomType",
    [CanaryType.ON_SESSION]: "frontend.sessionType",
    [CanaryType.ON_USER]: "frontend.userType"
}

/** What each strategy actually does, spelled out under the select and on the frontend card. */
export const CANARY_TYPE_DESCRIPTION_KEYS: Record<CanaryType, string> = {
    [CanaryType.RANDOM]: "frontend.canary_type_random_description",
    [CanaryType.ON_SESSION]: "frontend.canary_type_session_description",
    [CanaryType.ON_USER]: "frontend.canary_type_user_description"
}

export const CANARY_DEPLOYMENT_TYPE_LABEL_KEYS: Record<CanaryDeploymentType, string> = {
    [CanaryDeploymentType.BASED_ON_VERSION]: "frontend.deploymentTypes.basedOnVersion",
    [CanaryDeploymentType.BASED_ON_URL]: "frontend.deploymentTypes.basedOnUrl"
}

export const KIND_LABEL_KEYS: Record<FrontendKind, string> = {
    [FrontendKind.BUNDLE]: "frontend.kind.bundle",
    [FrontendKind.DOCKER]: "frontend.kind.docker"
}

/** Who serves it, under each option of the selector. */
export const KIND_DESCRIPTION_KEYS: Record<FrontendKind, string> = {
    [FrontendKind.BUNDLE]: "frontend.kind.bundle_description",
    [FrontendKind.DOCKER]: "frontend.kind.docker_description"
}

/** The short form shown on the node, the card and the table row. */
export const KIND_BADGE_KEYS: Record<FrontendKind, string> = {
    [FrontendKind.BUNDLE]: "frontend.kind.badge_bundle",
    [FrontendKind.DOCKER]: "frontend.kind.badge_docker"
}
