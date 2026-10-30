import * as z from "zod"
import type { EnvironmentVersion } from "@/hooks/apiClients/useBackendsApi"
import { BACKEND_VERSION } from "./backendVariables"

export type { EnvironmentVersion }

/** The form values of the version one environment runs: empty, it does not get the container */
export type EnvironmentVersionFormValues = { environmentId: string; version: string }

/** Same rule as the version of the container: the tag of the image */
export const createEnvironmentVersionsShape = (message: string) =>
    z.array(
        z.object({
            environmentId: z.string(),
            version: z
                .string()
                .trim()
                .refine(value => value === "" || BACKEND_VERSION.test(value), message)
        })
    )

/** What the form holds for the environments that run a version of their own */
export const environmentVersionFormValues = (container?: { environmentVersions?: EnvironmentVersion[] | null }): EnvironmentVersionFormValues[] =>
    (container?.environmentVersions ?? []).map(entry => ({ environmentId: entry.environmentId, version: entry.version ?? "" }))
