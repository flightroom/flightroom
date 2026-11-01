import { createBusinessException } from "../errors/BusinessException"

/**
 * Whether the email is among INSTALLATION_ADMINS: comma separated, compared trimmed and whatever the case. Unset or
 * empty, nobody administers the installation from the console; the role of a user plays no part.
 */
export const isInstallationAdmin = (email: string | undefined, admins: string | undefined): boolean => {
    const wanted = email?.trim().toLowerCase()
    if (!wanted || !admins) return false
    return admins
        .split(",")
        .map(admin => admin.trim().toLowerCase())
        .some(admin => admin === wanted)
}

/** Refuses whoever is not an installation administrator. */
export const ensureInstallationAdmin = (email: string | undefined, admins: string | undefined): void => {
    if (!isInstallationAdmin(email, admins)) {
        throw createBusinessException({ code: "INSTALLATION_ADMIN_REQUIRED", message: "Only an installation administrator can do this", statusCode: 403 })
    }
}
