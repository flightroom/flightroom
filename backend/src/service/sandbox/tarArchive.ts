import { gzipSync } from "node:zlib"

/** One regular file of an archive: its path relative to where the archive is extracted. */
export interface TarEntry {
    path: string
    content: Buffer
    /** Only the executable bit is kept: a script committed executable stays one. */
    executable?: boolean
}

const BLOCK = 512

const writeString = (header: Buffer, value: string, offset: number, length: number) => {
    header.write(value, offset, Math.min(Buffer.byteLength(value), length), "utf8")
}

/** Numbers are octal text, NUL terminated, filling the field. */
const writeOctal = (header: Buffer, value: number, offset: number, length: number) => {
    header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii")
}

/**
 * A ustar name is at most 100 bytes, or 155 more of prefix split at a slash: deeper paths cannot be
 * written without pax headers, and no repository the agent edits is expected to hold one.
 */
const splitName = (path: string): { name: string; prefix: string } => {
    if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" }
    for (let at = path.indexOf("/"); at !== -1; at = path.indexOf("/", at + 1)) {
        const prefix = path.slice(0, at)
        const name = path.slice(at + 1)
        if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix }
    }
    throw new Error(`"${path}" is too long to be archived`)
}

const header = (entry: TarEntry): Buffer => {
    const block = Buffer.alloc(BLOCK)
    const { name, prefix } = splitName(entry.path)
    writeString(block, name, 0, 100)
    writeOctal(block, entry.executable ? 0o755 : 0o644, 100, 8)
    writeOctal(block, 0, 108, 8)
    writeOctal(block, 0, 116, 8)
    writeOctal(block, entry.content.length, 124, 12)
    writeOctal(block, 0, 136, 12)
    // The checksum is computed with its own field as spaces.
    block.fill(" ", 148, 156)
    block.write("0", 156, 1, "ascii")
    block.write("ustar\0", 257, 6, "ascii")
    block.write("00", 263, 2, "ascii")
    writeString(block, prefix, 345, 155)
    let sum = 0
    for (const byte of block) sum += byte
    block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii")
    return block
}

/** A gzipped ustar archive of regular files, what `tar -xzf` extracts on any system. */
export const tarGz = (entries: TarEntry[]): Buffer => {
    const parts: Buffer[] = []
    for (const entry of entries) {
        parts.push(header(entry), entry.content)
        const padding = (BLOCK - (entry.content.length % BLOCK)) % BLOCK
        if (padding) parts.push(Buffer.alloc(padding))
    }
    parts.push(Buffer.alloc(BLOCK * 2))
    return gzipSync(Buffer.concat(parts))
}
