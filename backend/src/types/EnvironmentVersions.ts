/** The version one environment runs apart from the one of the application, e.g. production held on an older tag */
export interface EnvironmentVersion {
    environmentId: unknown
    version?: string | null
}

/** The version of an application, with those some environments run apart */
export interface VersionByEnvironment {
    version?: string
    environmentVersions?: EnvironmentVersion[] | null
}

/** The version an application runs in one environment: the one the environment sets, else the application's */
export const versionIn = (application: VersionByEnvironment, environmentId: unknown): string | undefined => {
    const own = application.environmentVersions?.find(entry => String(entry.environmentId) === String(environmentId))
    return own?.version?.trim() || application.version
}
