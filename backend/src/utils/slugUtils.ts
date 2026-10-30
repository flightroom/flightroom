/** Turns a display name into the url-friendly form: shared by the services that derive a slug from a name. */
export const slugify = (name: string): string =>
    name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
