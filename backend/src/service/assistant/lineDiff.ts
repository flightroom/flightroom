/** Above this many cells of the line table, the lines in between the common start and end are all counted as changed. */
const MAX_TABLE_CELLS = 1_000_000
const CONTEXT_LINES = 3

type Edit = { kind: " " | "-" | "+"; line: string }

/** The lines of a text: the newline ending the last one opens no line of its own. */
const linesOf = (text: string | undefined) => (text ? text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n") : [])

/** The lines in common at the start and at the end of both texts. */
const commonEnds = (before: string[], after: string[]) => {
    let start = 0
    while (start < before.length && start < after.length && before[start] === after[start]) start++
    let end = 0
    while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++
    return { start, end }
}

/**
 * The edits turning `before` into `after`, line by line, as a longest common subsequence finds them. The common
 * start and end are matched first, and a middle too large for the table is taken as removed then added: a file
 * rewritten whole reads so anyway.
 */
const editsOf = (before: string[], after: string[]): Edit[] => {
    const { start, end } = commonEnds(before, after)
    const oldMiddle = before.slice(start, before.length - end)
    const newMiddle = after.slice(start, after.length - end)
    const head: Edit[] = before.slice(0, start).map(line => ({ kind: " ", line }))
    const tail: Edit[] = before.slice(before.length - end).map(line => ({ kind: " ", line }))
    const rows = oldMiddle.length
    const columns = newMiddle.length
    if ((rows + 1) * (columns + 1) > MAX_TABLE_CELLS) {
        return [...head, ...oldMiddle.map(line => ({ kind: "-" as const, line })), ...newMiddle.map(line => ({ kind: "+" as const, line })), ...tail]
    }
    // lengths[i][j]: the longest common subsequence of oldMiddle[i..] and newMiddle[j..].
    const width = columns + 1
    const lengths = new Uint32Array((rows + 1) * width)
    for (let i = rows - 1; i >= 0; i--) {
        for (let j = columns - 1; j >= 0; j--) {
            lengths[i * width + j] = oldMiddle[i] === newMiddle[j] ? lengths[(i + 1) * width + j + 1] + 1 : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1])
        }
    }
    const middle: Edit[] = []
    let i = 0
    let j = 0
    while (i < rows || j < columns) {
        if (i < rows && j < columns && oldMiddle[i] === newMiddle[j]) {
            middle.push({ kind: " ", line: oldMiddle[i] })
            i++
            j++
        } else if (i < rows && (j >= columns || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
            // Removed lines first, as a diff reads: what goes, then what comes in its place.
            middle.push({ kind: "-", line: oldMiddle[i++] })
        } else {
            middle.push({ kind: "+", line: newMiddle[j++] })
        }
    }
    return [...head, ...middle, ...tail]
}

/**
 * How many lines a change adds and removes, cheaply: what lies between the lines the two texts share at their start
 * and at their end counts as removed and added. A change in two far apart places counts the lines between them too:
 * the diff, when asked, is exact.
 */
export const changedLines = (before: string | undefined, after: string | undefined): { added: number; removed: number } => {
    const oldLines = linesOf(before)
    const newLines = linesOf(after)
    const { start, end } = commonEnds(oldLines, newLines)
    return { added: newLines.length - start - end, removed: oldLines.length - start - end }
}

/** The change as a unified diff, three lines of context around each hunk, cut at `maxChars`. */
export const unifiedDiff = (path: string, before: string | undefined, after: string | undefined, maxChars: number): { diff: string; truncated: boolean } => {
    const edits = editsOf(linesOf(before), linesOf(after))
    const changed = edits.map((edit, index) => (edit.kind === " " ? -1 : index)).filter(index => index >= 0)
    const out: string[] = [`--- a/${path}`, `+++ b/${path}`]
    let hunkStart = -1
    let hunkEnd = -1
    const flush = () => {
        if (hunkStart < 0) return
        const slice = edits.slice(hunkStart, hunkEnd + 1)
        const oldCount = slice.filter(edit => edit.kind !== "+").length
        const newCount = slice.filter(edit => edit.kind !== "-").length
        // An empty side starts at the line before it, as in `@@ -0,0 +1,3 @@` for a created file.
        const oldStart = edits.slice(0, hunkStart).filter(edit => edit.kind !== "+").length + (oldCount ? 1 : 0)
        const newStart = edits.slice(0, hunkStart).filter(edit => edit.kind !== "-").length + (newCount ? 1 : 0)
        out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
        out.push(...slice.map(edit => `${edit.kind}${edit.line}`))
    }
    for (const index of changed) {
        const from = Math.max(0, index - CONTEXT_LINES)
        const to = Math.min(edits.length - 1, index + CONTEXT_LINES)
        if (hunkStart >= 0 && from <= hunkEnd + 1) {
            hunkEnd = Math.max(hunkEnd, to)
            continue
        }
        flush()
        hunkStart = from
        hunkEnd = to
    }
    flush()
    const diff = out.join("\n")
    return diff.length > maxChars ? { diff: `${diff.slice(0, maxChars)}…`, truncated: true } : { diff, truncated: false }
}
