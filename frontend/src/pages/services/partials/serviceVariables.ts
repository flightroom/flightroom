import { useQuery } from "@tanstack/react-query"
import * as z from "zod"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import useProjectApi, { type ProjectExposure } from "@/hooks/apiClients/useProjectApi"
import useProjectStore from "@/store/useProjectStore"

/** Same rule as the backend (SERVICE_HTTP_PATH): a probe or docs path is absolute, at most 256 characters, without whitespace */
export const SERVICE_HTTP_PATH = /^\/\S{0,255}$/

/** Same rule as the backend (SERVICE_VERSION): the version is the tag of the image, which takes no `+`, space or slash */
export const SERVICE_VERSION = /^[A-Za-z0-9._-]{1,128}$/

/** Same rule as the backend: what an HTTPRoute takes as a path, no query, fragment, // nor . or .. segment */
const EXPOSURE_PATH = /^(?!.*%2[fF])(\/|(\/(?!\.{1,2}(\/|$))([-A-Za-z0-9._~!$&'()*+,;=:@]|%[0-9a-fA-F]{2})+)+\/?)$/

/**
 * The form fields of what a container declares, with the rules of the backend: shared by a service and by a
 * frontend served by its own container, which declares the same.
 */
export const createServiceRuntimeShape = (messages: { path: string }) => ({
    port: z.string().regex(/^\d{1,5}$/),
    livenessPath: z.string().trim().regex(SERVICE_HTTP_PATH, messages.path),
    readinessPath: z.string().trim().regex(SERVICE_HTTP_PATH, messages.path),
    // Blank: the service publishes no API docs
    docsPath: z
        .string()
        .trim()
        .refine(value => value === "" || SERVICE_HTTP_PATH.test(value), messages.path),
    openApiPath: z
        .string()
        .trim()
        .refine(value => value === "" || SERVICE_HTTP_PATH.test(value), messages.path),
    // Form only: whether it is exposed on the host of the environments, at exposurePath (checked by refineExposure)
    exposed: z.boolean(),
    exposurePath: z.string().trim(),
    image: z.object({ repository: z.string().optional() }).optional(),
    env: z.array(
        z.object({
            name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
            required: z.boolean().default(false),
            secret: z.boolean().default(false),
            description: z.string().optional()
        })
    ),
    configMapIds: z.array(z.string()),
    secretIds: z.array(z.string())
})

/** Exposed, it needs a path an HTTPRoute takes; not exposed, the hidden path is not checked, since null is what is sent */
export const refineExposure = (data: { exposed?: boolean; exposurePath?: string }, ctx: z.RefinementCtx, messages: { exposurePath: string; exposurePathRequired: string }) => {
    if (!data.exposed) return
    const path = data.exposurePath?.trim() ?? ""
    if (!path) {
        ctx.addIssue({ code: "custom", message: messages.exposurePathRequired, path: ["exposurePath"] })
    } else if (path.length > 256 || !EXPOSURE_PATH.test(path)) {
        ctx.addIssue({ code: "custom", message: messages.exposurePath, path: ["exposurePath"] })
    }
}

/** Same rule as the backend (effectiveSubdomain): the subdomain set on it, else none for a production one and its slug in lowercase for the others */
export const effectiveSubdomain = (environment: Pick<EnvironmentDTO, "slug" | "subdomain" | "isProduction">): string =>
    environment.subdomain || (environment.isProduction ? "" : environment.slug.toLowerCase())

/** Same as the backend (exposedOrigin): where browsers reach an environment, over HTTPS only when the project has a certificate issuer */
export const exposedOrigin = (exposure: ProjectExposure, environment: Pick<EnvironmentDTO, "slug" | "subdomain" | "isProduction">): string => {
    const subdomain = effectiveSubdomain(environment)
    return `${exposure.certificateIssuer ? "https" : "http"}://${subdomain ? `${subdomain}.${exposure.domain}` : exposure.domain}`
}

/** The environments of the current project, in their order: the rows of the endpoint, the config maps and the secrets */
export const useProjectEnvironmentsQuery = () => {
    const projectId = useProjectStore(state => state.project?._id)
    const projectApi = useProjectApi()

    return useQuery({ queryKey: ["environments", projectId], queryFn: () => projectApi.getEnvironmentsByProjectId(projectId!), enabled: !!projectId })
}
