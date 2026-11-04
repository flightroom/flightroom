import fs from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { IProject } from "../../models/ProjectModel"

// Isolate the host folder: getFrontendStreamLocal reads it from the app config. vi.mock is hoisted
// above module init, so the folder is computed in vi.hoisted (which runs first) and reused below.
const HOST = vi.hoisted(() => `${process.env.TMPDIR || process.env.TEMP || "/tmp"}/fr-serve-${process.pid}-${Date.now()}`)
vi.mock("../..", () => ({ fastify: { config: { MICROFRONTEND_HOST_FOLDER: HOST } } }))

import { getFrontendStreamLocal } from "./frontendStreams"

const project = { slug: "proj", _id: { toString: () => "000000000000000000000001" } } as unknown as IProject
const base = path.join(HOST, "proj-000000000000000000000001", "cart", "1.0.0")

beforeAll(() => {
    fs.mkdirSync(base, { recursive: true })
    fs.writeFileSync(path.join(base, "index.js"), "console.log(1)")
    // A file outside the frontend folder a traversal would try to reach.
    fs.writeFileSync(path.join(HOST, "secret.txt"), "TOP SECRET")
})
afterAll(() => fs.rmSync(HOST, { recursive: true, force: true }))

describe("getFrontendStreamLocal path confinement", () => {
    it("serves a file inside the frontend folder", () => {
        const stream = getFrontendStreamLocal(project, "cart", "1.0.0", "index.js")
        expect(stream).toBeDefined()
        // The read stream opens lazily; swallow any late open error and close it so teardown's
        // directory removal cannot surface an unhandled 'error' event after the test.
        ;(stream as fs.ReadStream).on("error", () => undefined)
        ;(stream as fs.ReadStream).destroy()
    })

    it("refuses a percent-decoded traversal out of the frontend folder", () => {
        // `..%2f..%2f..%2fsecret.txt` reaches the handler decoded as this:
        expect(() => getFrontendStreamLocal(project, "cart", "1.0.0", "../../../secret.txt")).toThrow()
    })

    it("refuses an absolute path", () => {
        expect(() => getFrontendStreamLocal(project, "cart", "1.0.0", "/etc/hostname")).toThrow()
    })
})
