/** The version an application runs in one environment: the tag of its image there */
export interface EnvironmentVersion {
    environmentId: unknown
    version?: string | null
}

/**
 * The version of an application, the latest the CI registered or one set by hand, and the one each environment runs.
 * The first is never deployed as it is: an environment with no version of its own does not get the application.
 */
export interface VersionByEnvironment {
    version?: string
    environmentVersions?: EnvironmentVersion[] | null
}

/** The version an application runs in one environment: none when the environment sets none */
export const versionIn = (application: Pick<VersionByEnvironment, "environmentVersions">, environmentId: unknown): string | undefined =>
    application.environmentVersions?.find(entry => String(entry.environmentId) === String(environmentId))?.version?.trim() || undefined

/** Whether some environment runs the application */
export const hasEnvironmentVersion = (application: Pick<VersionByEnvironment, "environmentVersions">): boolean => Boolean(application.environmentVersions?.some(entry => entry.version?.trim()))
