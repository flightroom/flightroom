import * as z from "zod"
import { CanaryType, FrontendKind } from "@/hooks/apiClients/useFrontendsApi"
import { BACKEND_VERSION, createBackendRuntimeShape, refineExposure } from "@/pages/backends/partials/backendVariables"
import { type ResourceMessages, refineResources } from "@/pages/backends/partials/containerResources"
import { HTTP_URL, NPM_PACKAGE_NAME } from "@/pages/settings/partials/DesignSystemFields"
import { CONTEXT_MAX_LENGTH } from "@/pages/settings/partials/ProjectContextSection"

export interface FormMessages extends ResourceMessages {
    path: string
    exposurePath: string
    exposurePathRequired: string
    versionRequired: string
    versionInvalid: string
    hostUrlRequired: string
    canaryPercentage: string
    designSystemPackageRequired: string
    designSystemPackageInvalid: string
    designSystemDocsUrlInvalid: string
}

export const createFormSchema = (messages: FormMessages) => {
    // What a DOCKER declares about its container, with the same rules as a backend
    const containerSchema = z.object(createBackendRuntimeShape(messages))

    return z
        .object({
            // General Information
            slug: z.string().min(3).max(50),
            name: z.string().min(3).max(100),
            description: z.string().optional(),
            domainId: z.string().nullable().optional(),
            kind: z.enum(FrontendKind),
            context: z.string().max(CONTEXT_MAX_LENGTH).optional(),
            // Off, the frontend builds with the design system of the project, else the organization's
            designSystemOverride: z.boolean().default(false),
            designSystem: z.object({ packageName: z.string(), version: z.string(), docsUrl: z.string(), npmrc: z.string(), notes: z.string() }).partial().optional(),
            // Required below for a BUNDLE only: a DOCKER frontend's is set here or by its pipeline on the first registration
            version: z.string().optional(),
            customVersion: z.string().optional(),
            continuousDeployment: z.boolean().default(false),

            // Hosting Information
            host: z.object({
                type: z.enum(["MFE_ORCHESTRATOR_HUB", "CUSTOM_URL", "CUSTOM_SOURCE"]),
                url: z.string().optional(),
                storageId: z.string().optional(),
                entryPoint: z.string().optional()
            }),

            // Container of a DOCKER: held for a BUNDLE too, so switching kind keeps what was typed, and checked below only for a DOCKER
            port: z.string().optional(),
            livenessPath: z.string().optional(),
            readinessPath: z.string().optional(),
            docsPath: z.string().optional(),
            openApiPath: z.string().optional(),
            cpuRequest: z.string().optional(),
            cpuLimit: z.string().optional(),
            memoryRequest: z.string().optional(),
            memoryLimit: z.string().optional(),
            environmentResources: z.array(z.object({ environmentId: z.string(), cpuRequest: z.string(), cpuLimit: z.string(), memoryRequest: z.string(), memoryLimit: z.string() })).optional(),
            exposed: z.boolean().optional(),
            exposurePath: z.string().optional(),
            image: z.object({ repository: z.string().optional() }).optional(),
            env: z
                .array(
                    z.object({
                        name: z.string(),
                        required: z.boolean().default(false),
                        secret: z.boolean().default(false),
                        description: z.string().optional()
                    })
                )
                .optional(),
            configMapIds: z.array(z.string()).optional(),
            secretIds: z.array(z.string()).optional(),

            // Code Repository Settings
            codeRepository: z
                .object({
                    enabled: z.boolean().default(false),
                    codeRepositoryId: z.string().optional(),
                    repositoryId: z.string().optional(),
                    name: z.string().optional(),
                    cloneUrlHttps: z.string().optional(),
                    cloneUrlSsh: z.string().optional(),
                    gitlab: z
                        .object({
                            groupPath: z.string().optional(),
                            groupId: z.number().optional()
                        })
                        .optional(),
                    createData: z
                        .object({
                            name: z.string().min(3).max(100),
                            private: z.boolean().default(false)
                        })
                        .optional()
                })
                .optional(),

            // Canary Settings
            canary: z
                .object({
                    enabled: z.boolean().default(false),
                    percentage: z.number().min(0).max(100).default(0),
                    type: z.enum(CanaryType).optional(),
                    deploymentType: z.enum(["BASED_ON_VERSION", "BASED_ON_URL"]).optional(),
                    url: z.string().optional(),
                    version: z.string().optional()
                })
                .optional()
        })
        .superRefine((data, ctx) => {
            // Its own design system, whatever its kind, needs its npm package
            if (data.designSystemOverride) {
                const packageName = data.designSystem?.packageName?.trim() ?? ""
                if (!NPM_PACKAGE_NAME.test(packageName)) {
                    ctx.addIssue({ code: "custom", message: packageName ? messages.designSystemPackageInvalid : messages.designSystemPackageRequired, path: ["designSystem", "packageName"] })
                }
                const docsUrl = data.designSystem?.docsUrl?.trim()
                if (docsUrl && !HTTP_URL.test(docsUrl)) {
                    ctx.addIssue({ code: "custom", message: messages.designSystemDocsUrlInvalid, path: ["designSystem", "docsUrl"] })
                }
            }
            if (data.kind === FrontendKind.DOCKER) {
                // Its container, with the same rules as a backend: every issue lands on the field it is about
                const container = containerSchema.safeParse(data)
                for (const issue of container.error?.issues ?? []) {
                    ctx.addIssue({ code: "custom", message: issue.message, path: issue.path })
                }
                refineExposure(data, ctx, messages)
                refineResources(data, ctx, messages)
                // Optional, as for a backend: it is the tag of the image, with the same rule
                if (data.version?.trim() && !BACKEND_VERSION.test(data.version.trim())) {
                    ctx.addIssue({ code: "custom", message: messages.versionInvalid, path: ["version"] })
                }
                return
            }
            if (!data.version) {
                ctx.addIssue({ code: "custom", message: messages.versionRequired, path: ["version"] })
            }
            if (data.host.type === "CUSTOM_URL" && !data.host.url) {
                ctx.addIssue({ code: "custom", message: messages.hostUrlRequired, path: ["host"] })
            }
            // On User serves the canary to an enrolled list, so it has no traffic share to validate.
            if (data.canary?.enabled && data.canary.type !== CanaryType.ON_USER && !(data.canary.percentage > 0 && data.canary.percentage <= 100)) {
                ctx.addIssue({ code: "custom", message: messages.canaryPercentage, path: ["canary.percentage"] })
            }
        })
}

type FormSchema = ReturnType<typeof createFormSchema>

// The defaults of the schema make some fields optional in what the form holds and required in what it submits
export type FormInput = z.input<FormSchema>
export type FormValues = z.output<FormSchema>
