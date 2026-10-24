import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { tarGz } from "./tarArchive"

const hasTar = spawnSync("tar", ["--version"]).status === 0

describe.skipIf(!hasTar)("tarGz", () => {
    let dir: string

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "tar-archive-"))
    })

    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

    const extract = (archive: Buffer) => execFileSync("tar", ["-xzf", "-"], { cwd: dir, input: archive })

    it("Given files in folders, when the archive is extracted by tar, then every file comes back with its content", () => {
        extract(
            tarGz([
                { path: "package.json", content: Buffer.from('{"name":"shop"}') },
                { path: "src/components/Ü-button.tsx", content: Buffer.from("export const Button = () => null\n") },
                { path: "empty.txt", content: Buffer.alloc(0) }
            ])
        )
        expect(fs.readFileSync(path.join(dir, "package.json"), "utf8")).toBe('{"name":"shop"}')
        expect(fs.readFileSync(path.join(dir, "src/components/Ü-button.tsx"), "utf8")).toBe("export const Button = () => null\n")
        expect(fs.readFileSync(path.join(dir, "empty.txt"), "utf8")).toBe("")
    })

    it("Given a path longer than 100 bytes, when the archive is extracted, then it is split into prefix and name and comes back whole", () => {
        const deep = `${"packages/".repeat(10)}${"a".repeat(60)}/index.ts`
        extract(tarGz([{ path: deep, content: Buffer.from("deep") }]))
        expect(fs.readFileSync(path.join(dir, deep), "utf8")).toBe("deep")
    })

    it("Given an executable file, when the archive is extracted, then it is still executable", () => {
        extract(tarGz([{ path: "gradlew", content: Buffer.from("#!/bin/sh\n"), executable: true }]))
        expect(fs.statSync(path.join(dir, "gradlew")).mode & 0o100).toBe(0o100)
    })

    it("Given a binary file of several blocks, when the archive is extracted, then it is identical", () => {
        const content = Buffer.from(Array.from({ length: 5_000 }, (_, index) => (index * 7919) % 256))
        extract(tarGz([{ path: "logo.png", content }]))
        expect(fs.readFileSync(path.join(dir, "logo.png")).equals(content)).toBe(true)
    })

    it("Given a path no prefix can split, then it is refused", () => {
        expect(() => tarGz([{ path: "x".repeat(300), content: Buffer.alloc(0) }])).toThrow(/too long/)
    })
})
