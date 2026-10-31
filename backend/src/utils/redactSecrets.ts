/**
 * CI providers mask the secrets they know about, not tokens a script echoes on its own. Build logs, the output
 * of the commands the coding agent runs and what the models answer are free text: the usual credential shapes
 * are blanked before they are sent to a model or kept.
 */
const SECRET_PATTERNS: RegExp[] = [
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
    /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    /\bnpm_[A-Za-z0-9]{36}\b/g,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
]
/** `password=…`, `_authToken: …` and the like: the key stays, so the log still reads. */
const SECRET_ASSIGNMENT = /(_authToken|_auth|password|secret|token|api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"']{6,}/gi
/** Environment variables a script prints: `AWS_SECRET_ACCESS_KEY=…`, `NPM_TOKEN: …`, `DB_PWD=…`. */
const SECRET_VARIABLE = /\b([A-Z_]*(?:SECRET|KEY|TOKEN|PASSWORD|PASSWD|PWD)[A-Z_]*)(\s*[=:]\s*)\S+/g
const BEARER = /\b(Bearer\s+)\S+/gi
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g
/** Azure Storage connection strings and SAS tokens. */
const ACCOUNT_KEY = /\b(AccountKey=)[^;\s]+/gi
const SHARED_ACCESS_SIGNATURE = /\b(SharedAccessSignature=)[^;\s]+/gi
const SAS_SIGNATURE = /([?&]sig=)[^&\s"']+/gi
const URL_CREDENTIALS = /(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g

export const redactSecrets = (value: string): string =>
    SECRET_PATTERNS.reduce((redacted, pattern) => redacted.replace(pattern, "[REDACTED]"), value)
        .replace(PRIVATE_KEY, "[REDACTED PRIVATE KEY]")
        .replace(URL_CREDENTIALS, "$1[REDACTED]@")
        .replace(ACCOUNT_KEY, "$1[REDACTED]")
        .replace(SHARED_ACCESS_SIGNATURE, "$1[REDACTED]")
        .replace(SAS_SIGNATURE, "$1[REDACTED]")
        .replace(BEARER, "$1[REDACTED]")
        .replace(SECRET_VARIABLE, "$1$2[REDACTED]")
        .replace(SECRET_ASSIGNMENT, "$1$2[REDACTED]")
