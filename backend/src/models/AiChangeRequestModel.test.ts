import { Types } from "mongoose"
import { describe, expect, it } from "vitest"
import AiChangeRequest, { AiChangeStatus } from "./AiChangeRequestModel"

const request = (owner: Record<string, unknown>) =>
    new AiChangeRequest({
        projectId: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        conversationId: new Types.ObjectId(),
        prompt: "Add a 404 page",
        baseBranch: "main",
        status: AiChangeStatus.PENDING,
        ...owner
    })

describe("AiChangeRequest", () => {
    it("Given a request without its conversation, when it is validated, then it is refused", async () => {
        await expect(request({ frontendId: new Types.ObjectId(), conversationId: undefined }).validate()).rejects.toThrow(/conversationId/)
    })

    it.each([
        ["a frontend", { frontendId: new Types.ObjectId() }],
        ["a backend", { backendId: new Types.ObjectId() }]
    ])("Given a request on %s, when it is validated, then it is valid", async (_owner, owner) => {
        await expect(request(owner).validate()).resolves.toBeUndefined()
    })

    it.each([
        ["neither", {}],
        ["both", { frontendId: new Types.ObjectId(), backendId: new Types.ObjectId() }]
    ])("Given a request on %s a frontend nor a backend, when it is validated, then it is refused", async (_owner, owner) => {
        await expect(request(owner).validate()).rejects.toThrow(/Exactly one of frontendId and backendId/)
    })
})
