import { IEnvironment } from "../../models/EnvironmentModel"
import { FrontendKind, HostedOn, IFrontend } from "../../models/FrontendModel"
import { IProject } from "../../models/ProjectModel"
import { effectiveSubdomain, exposedOrigin } from "../../types/Exposure"
import { getBackendUrl } from "../../utils/backendUrl"
import { federationName } from "../FederationConfigService"
import { FrontendAdaptedToServe } from "./serveTypes"

/** Path segment marking the version inside a frontend file URL, ex. `/_v/1.4.0/assets/index.js`. */
export const VERSION_PATH_SEGMENT = "_v"

/**
 * The forms of the calling domain a registered domain can be matched against.
 *
 * The referer is a full url when the browser sends one and a bare host when getReferer falls back to
 * the Host header, so parsing has to tolerate both: `new URL("example.com")` throws, which used to
 * surface as a 500 on every "auto" url requested without a referer (a plain curl, a preload, a
 * browser under a no-referrer policy).
 */
export const refererMatchCandidates = (referer: string): string[] => {
    const parsed = parseUrlOrNull(referer) ?? parseUrlOrNull(`https://${referer}`)
    const candidates = [referer, parsed?.origin, parsed?.host, parsed?.hostname]
    return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate)))]
}

const parseUrlOrNull = (value: string): URL | null => {
    try {
        return new URL(value)
    } catch {
        return null
    }
}

export const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * @param pinnedVersion When set, the version is written into the path of the url.
 *
 * Pinning it here, instead of leaving the entrypoint redirect to do it, is what keeps the host page
 * independent from its bundler. A classic script (webpack `publicPath: 'auto'`) derives the base of
 * its chunks from `document.currentScript.src`, which is the url *before* any redirect: it would ask
 * for its chunks without the version and could end up mixing two of them. An url that already
 * carries the version has no redirect to follow, so both an ES module and a classic script resolve
 * their chunks on the same version.
 */
export const getFrontendUrlStatic = (frontend: IFrontend, environmentSlug?: string, pinnedVersion?: string): string => {
    if (!frontend.host) {
        throw new Error("Frontend host is not defined from frontend " + frontend.slug)
    }
    if (frontend.host.type === HostedOn.MFE_ORCHESTRATOR_HUB || frontend.host.type === HostedOn.CUSTOM_SOURCE) {
        const backendUrl = getBackendUrl()
        const versionPath = pinnedVersion ? `${VERSION_PATH_SEGMENT}/${pinnedVersion}/` : ""
        const entryPoint = frontend.host.entryPoint || "index.js"
        if (environmentSlug) {
            // The environment is already resolved here, so it goes into the url: an "auto" url would make the
            // browser resolve it again from the referer of the file request, which fails for any host page whose
            // domain is not registered on the environment even when it asked for that environment explicitly.
            return `${backendUrl}/serve/mfe/files/${frontend.projectId}/${environmentSlug}/${frontend.slug}/${versionPath}${entryPoint}`
        } else {
            return `${backendUrl}/serve/mfe/files/${frontend._id}/${versionPath}${entryPoint}`
        }
    } else if (frontend.host.type === HostedOn.CUSTOM_URL) {
        if (!frontend.host.url) {
            throw new Error("Frontend URL is not defined")
        }
        // `$version` is how a custom url carries the version, and it has to honour the resolved one:
        // substituting the deployed version here would hand out the stable bundle while the manifest
        // reports the canary version next to it, and the canary would never actually roll out.
        return frontend.host.url.replace("$version", pinnedVersion ?? frontend.version)
    } else {
        throw new Error("Frontend host type is not defined")
    }
}

/** Snapshots taken before `kind` existed hold none: those are all FRONTENDs */
export const isDocker = (frontend: Pick<IFrontend, "kind">): boolean => frontend.kind === FrontendKind.DOCKER

/**
 * Where the container of a DOCKER answers in the environment: its exposure path on the host of the environment,
 * there is nothing of ours to point at, without a trailing slash as the URL always had. Empty when it is not exposed or the project is exposed on no domain: the
 * DOCKER is a host asking for its own configuration, which must not fail for want of an address nobody loads it from.
 */
export const getFrontendUrl = (frontend: IFrontend, environment: Pick<IEnvironment, "slug" | "subdomain" | "isProduction">, exposure?: IProject["exposure"]): string =>
    exposure?.domain && frontend.exposurePath ? `${exposedOrigin(exposure, effectiveSubdomain(environment))}${frontend.exposurePath.replace(/\/+$/, "")}` : ""

export const getFrontendUrlCanary = (frontend: IFrontend): string => {
    if (!frontend.canary?.url) {
        throw new Error("Frontend canary URL is not defined")
    }
    return frontend.canary.url
}

/**
 * @param servedVersion Version the url actually resolves to. It is the one reported back, so that a
 * browser landing on a canary is not told it is running the stable version.
 */
export const buildFrontendAdaptedToServe = (frontend: IFrontend, url: string, servedVersion?: string): FrontendAdaptedToServe => ({
    url,
    version: servedVersion || frontend.version,
    name: frontend.name,
    slug: frontend.slug,
    continuousDeployment: frontend.continuousDeployment,
    nameToIntegrate: frontend?.slug ? federationName(frontend.slug) : `mfe${frontend._id}`
})
