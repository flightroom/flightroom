/** The longest branch name accepted: providers refuse longer refs anyway */
export const GIT_REF_MAX_LENGTH = 255

/** Characters `git check-ref-format` refuses anywhere in a ref */
const FORBIDDEN_CHARACTERS = /[~^:?*[\\]/

/**
 * Whether `ref` is a branch name git accepts, by the rules of `git check-ref-format`: no space nor control
 * character, none of ~^:?*[\, no "..", no "@{", no slash at either end nor two in a row, no part starting
 * with a dot, no ".lock" or "." at the end. It ends up in provider URLs: a name outside them never reaches one.
 */
export const isValidRefName = (ref: string): boolean =>
    ref.length > 0 &&
    ref.length <= GIT_REF_MAX_LENGTH &&
    ref !== "@" &&
    ![...ref].some(character => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f) &&
    !FORBIDDEN_CHARACTERS.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("@{") &&
    !ref.startsWith("/") &&
    !ref.endsWith("/") &&
    !ref.includes("//") &&
    !ref.endsWith(".lock") &&
    !ref.endsWith(".") &&
    !ref.split("/").some(part => part.startsWith("."))
