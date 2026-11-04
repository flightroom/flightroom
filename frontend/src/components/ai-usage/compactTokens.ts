const UNITS = [
    { value: 1_000_000_000, suffix: "B" },
    { value: 1_000_000, suffix: "M" },
    { value: 1_000, suffix: "k" }
]

/**
 * A count of tokens the way people say it: 950, 12k, 4.5M. One decimal under ten of a unit, none above, in the
 * language's decimal separator. Not Intl's compact notation: in Italian it leaves the thousands as they are.
 */
export const compactTokens = (value: number, language: string): string => {
    const unit = UNITS.find(candidate => Math.abs(value) >= candidate.value)
    if (!unit) return Math.round(value).toLocaleString(language)
    const scaled = value / unit.value
    // 999.95k would read as 1000k: it is 1M
    const digits = Math.abs(scaled) < 10 ? 1 : 0
    const rounded = Number(scaled.toFixed(digits))
    const next = UNITS[UNITS.indexOf(unit) - 1]
    if (next && Math.abs(rounded) >= 1000) return compactTokens(Math.sign(value) * next.value, language)
    return `${rounded.toLocaleString(language, { maximumFractionDigits: digits })}${unit.suffix}`
}
