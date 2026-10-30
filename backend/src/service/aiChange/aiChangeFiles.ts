import { AI_CHANGE_LIMITS } from "./aiChangeLimits"

/** Sorts folder paths as a tree: "src/a" right after "src", before "src-old". */
const byTreeOrder = (a: string, b: string) => {
    const [left, right] = [a.replaceAll("/", "\0"), b.replaceAll("/", "\0")]
    if (left === right) return 0
    return left < right ? -1 : 1
}

/**
 * The files at the root and the folders of a repository with how many files each holds, as deep as
 * fits in {@link AI_CHANGE_LIMITS.maxLayoutLines}: where to look, without listing every file.
 */
export const describeLayout = (files: string[]): string => {
    const rootFiles = files.filter(file => !file.includes("/"))
    const shownRootFiles = rootFiles.slice(0, 30)
    const rootLines = [...shownRootFiles, ...(rootFiles.length > shownRootFiles.length ? [`… ${rootFiles.length - shownRootFiles.length} more files at the root`] : [])]
    // Split once for every depth tried, not once per depth.
    const foldersOfFiles = files.map(file => file.split("/").slice(0, -1))
    let folderLines: string[] = []
    for (const depth of [3, 2, 1]) {
        const counts = new Map<string, number>()
        for (const folders of foldersOfFiles) {
            for (let level = 1; level <= Math.min(depth, folders.length); level++) {
                const folder = folders.slice(0, level).join("/")
                counts.set(folder, (counts.get(folder) ?? 0) + 1)
            }
        }
        folderLines = [...counts.keys()].sort(byTreeOrder).map(folder => {
            const parts = folder.split("/")
            return `${"  ".repeat(parts.length - 1)}${parts.at(-1)}/ (${counts.get(folder)})`
        })
        if (rootLines.length + folderLines.length <= AI_CHANGE_LIMITS.maxLayoutLines) break
    }
    // The line saying how many folders are left out takes one of the lines too.
    const fits = rootLines.length + folderLines.length <= AI_CHANGE_LIMITS.maxLayoutLines
    const room = fits ? folderLines.length : Math.max(0, AI_CHANGE_LIMITS.maxLayoutLines - rootLines.length - 1)
    const cut = fits ? [] : [`… ${folderLines.length - room} more folders: list_files shows them`]
    return [...folderLines.slice(0, room), ...cut, ...rootLines].join("\n") || "(empty)"
}

/** The start of a text cut at a byte count: a character the cut splits is left out, not turned into �. */
export const decodeStart = (buffer: Buffer) => new TextDecoder("utf-8").decode(buffer, { stream: true })

/** The lines of a text, without the empty one after its final newline. */
export const linesOf = (text: string) => {
    const lines = text.split("\n")
    if (lines.at(-1) === "") lines.pop()
    return lines
}

/** The lines of `content` equal to the first line of `snippet`, indentation aside, numbered from 1. */
export const linesHolding = (content: string, snippet: string): number[] => {
    const first = snippet
        .split("\n")
        .map(line => line.trim())
        .find(Boolean)
    if (!first) return []
    return linesOf(content).flatMap((line, index) => (line.trim() === first ? [index + 1] : []))
}

/** The matches of one file for search, the `context` lines around each, at most `budget` matches. */
export const matchingLines = (shown: string, lines: string[], needle: string, context: number, budget: number) => {
    const output: string[] = []
    const isMatch = (index: number) => lines[index].toLowerCase().includes(needle)
    let matches = 0
    let printed = -1
    for (let index = 0; index < lines.length && matches < budget; index++) {
        if (!isMatch(index)) continue
        matches++
        const from = Math.max(index - context, printed + 1)
        const to = Math.min(index + context, lines.length - 1)
        if (context > 0 && printed >= 0 && from > printed + 1) output.push("--")
        for (let at = from; at <= to; at++) {
            const mark = isMatch(at) ? ":" : "-"
            output.push(`${shown}${mark}${at + 1}${mark} ${lines[at].trim().slice(0, 300)}`)
        }
        printed = Math.max(printed, to)
    }
    return { output, matches }
}

/** A path the agent passed, without the "./" or "/" it may start with. */
export const withoutLeadingSlash = (requested: string) => requested.replace(/^\.?\/+/, "")

/** A folder the agent passed, without leading "./" or "/" and trailing "/": "" for the root. */
export const normalizeFolder = (prefix = "") => withoutLeadingSlash(prefix).replace(/\/+$/, "")

export const underPrefix = (file: string, prefix?: string) => {
    if (!prefix) return true
    const folder = normalizeFolder(prefix)
    return folder === "" || file === folder || file.startsWith(`${folder}/`)
}

export const looksBinary = (buffer: Buffer) => buffer.subarray(0, 8_000).includes(0)
