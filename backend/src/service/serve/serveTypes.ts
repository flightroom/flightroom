import { ObjectId } from "mongoose"
import Stream from "stream"
import { IDeployment } from "../../models/DeploymentModel"
import { IEnvironment } from "../../models/EnvironmentModel"
import { IFrontend } from "../../models/FrontendModel"
import { IGlobalVariable } from "../../models/GlobalVariableModel"
import { FrontendCompiler, FrontendFramework, FrontendStackSource } from "../../types/FrontendStack"
import { IntegrationInstructions } from "../FederationConfigService"

export interface GetRemotesRequestDTO {
    frontendId: string | ObjectId
    deploymentId?: string | ObjectId
    environmentId?: string | ObjectId
}

export interface GetRemotesResponseDTO {
    filteredFrontends: IFrontend[]
    environment: IEnvironment
    frontend: IFrontend
    deployment: IDeployment
}

export interface FrontendAdaptedToServe {
    url: string
    slug: string
    continuousDeployment?: boolean
    version: string
    name: string
    nameToIntegrate: string
}

export interface GetAllDataDTO {
    globalVariables?: IGlobalVariable[]
    /** Under its old name: the host applications read it through the client SDK */
    microfrontends?: FrontendAdaptedToServe[]
}

export interface StreamWithHeader {
    stream: Stream
    headers: Record<string, string>
}

/**
 * Asks the caller to retry on a URL carrying the resolved version, instead of returning content.
 * See getFrontendByDeployment for why the entrypoint of a canary frontend needs it.
 */
export interface RedirectToVersion {
    redirectToVersion: string
    headers: Record<string, string>
}

export type ServeFileResult = StreamWithHeader | RedirectToVersion

export const isRedirectToVersion = (result: ServeFileResult): result is RedirectToVersion => "redirectToVersion" in result

export interface CodeIntegrationRequestDTO extends GetRemotesRequestDTO {
    /** Framework override, defaulting to the stack stored on the frontend */
    framework?: string
    /** Bundler override, defaulting to the stack stored on the frontend */
    compiler?: string
}

export interface CodeIntegrationResponseDTO extends IntegrationInstructions {
    /** The stack the instructions were generated for, so the screen can say which one it picked */
    stack: {
        framework?: FrontendFramework
        compiler?: FrontendCompiler
        source?: FrontendStackSource
    }
}
