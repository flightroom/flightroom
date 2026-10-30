import { LlmClient, LlmMessage } from "../llm"
import { AgentLoopOptions, runAgentLoop, runToolsInOrder } from "../llm/agentLoop"
import { compactTranscript } from "../llm/transcript"
import { AiChangeAgentHooks, AiChangeAgentInput, AiChangeAgentResult } from "./aiChangeAgentTypes"
import { AI_CHANGE_DEFAULT_EFFORT, AI_CHANGE_LIMITS, agentLimitsFor } from "./aiChangeLimits"
import { componentOf, describeBackendEndpoints, describeInput, describeNextMessage, systemPrompt } from "./aiChangePrompt"
import { AiChangeToolbox, buildFirst } from "./aiChangeToolbox"
import { describeToolCall } from "./aiChangeTools"
import { ApiSpecReader } from "./apiSpecReader"

/**
 * Runs the agent on prepared working copies until it calls finish, answers without calling a tool,
 * or runs out of rounds. It only ever touches files inside those working copies; reading the
 * resulting changes is up to the caller.
 *
 * With a `history` the run goes on with the conversation of the previous one: the model sees what it
 * read, wrote and said before, and the new request as the user's next message.
 */
export const runAiChangeAgent = async (client: LlmClient, input: AiChangeAgentInput, hooks: AiChangeAgentHooks, signal?: AbortSignal): Promise<AiChangeAgentResult> => {
    const toolbox = new AiChangeToolbox(
        input.repositories.map(repository => ({
            slug: componentOf(repository).slug,
            kind: repository.frontend ? "frontend" : "backend",
            framework: repository.backend?.framework,
            runtime: repository.backend?.runtime,
            port: repository.backend?.port,
            workingCopy: repository.workingCopy,
            previousChanges: repository.previousChanges,
            npmrc: repository.frontend?.designSystem?.npmrc
        })),
        input.sandbox,
        signal,
        input.previewsEnabled,
        hooks.onEvent
    )
    // Sent with the new request only: the transcript keeps a note of them, not the images.
    const images = input.images?.length ? { images: input.images } : {}
    // A conversation that goes on already holds the maps of its first message.
    const messages: LlmMessage[] = input.history?.length
        ? [...input.history, { role: "user", text: describeNextMessage(input), ...images }]
        : [{ role: "user", text: describeInput(input, await toolbox.repositoryMaps()), ...images }]

    const effort = input.effort ?? AI_CHANGE_DEFAULT_EFFORT
    // One per run: each document is read once however many times the agent asks for it
    const apiSpecs = new ApiSpecReader(input.apiSpecs ?? [])
    const maxRounds = agentLimitsFor(input.repositories.length).maxRounds
    let rounds = 0
    const options: AgentLoopOptions = {
        client,
        system: systemPrompt(input.repositories, {
            apiResources: apiSpecs.resources.length > 0,
            backendEndpoints: describeBackendEndpoints(input.repositories) !== undefined,
            scripts: input.sandbox !== undefined
        }),
        tools: toolbox.tools(apiSpecs.resources),
        messages,
        maxRounds,
        maxTokens: AI_CHANGE_LIMITS.maxTokensPerTurn[effort],
        effort,
        signal,
        rateLimitWaitsMs: AI_CHANGE_LIMITS.rateLimitWaitsMs,
        onRateLimited: () => hooks.onEvent("info", "rate-limited"),
        onTurn: async result => {
            rounds++
            await hooks.onUsage(result.usage)
            if (result.stopReason === "refusal") return
            // The reasoning first: the model thought it through before saying and doing what the turn holds.
            if (result.thinking?.trim()) await hooks.onEvent("thinking", result.thinking.trim().slice(0, 1_000))
            if (result.text.trim()) await hooks.onEvent("text", result.text.trim().slice(0, 1_000))
        },
        // One at a time: writes and reads of the same file must happen in the order the model asked for.
        runTools: async calls => ({
            results: await runToolsInOrder(calls, async call => {
                await hooks.onEvent("tool", describeToolCall(call.name, call.input))
                if (call.name === "read_api_spec" && apiSpecs.resources.length) return apiSpecs.read(call.input)
                const result = await toolbox.run(call.name, call.input)
                // What a script printed is shown as the agent read it: the command, its exit code and the end of its output.
                if (call.name === "run_script") await hooks.onEvent("output", result)
                return result
            }),
            stop: toolbox.summary !== undefined
        })
    }
    let loop = await runAgentLoop(options)
    // An answer in plain text ends the run too, and what the agent changed is pushed all the same: built first, once asked.
    const unbuilt = loop.stopReason === "end_turn" && rounds < maxRounds ? await toolbox.unbuiltRepositories() : []
    if (unbuilt.length) {
        await hooks.onEvent("info", "build-required")
        messages.push({ role: "user", text: `[Flightroom, not the user] ${buildFirst(unbuilt, input.repositories.length > 1)}` })
        loop = await runAgentLoop({ ...options, maxRounds: maxRounds - rounds })
    }

    const stopReason = loop.stopReason === "stopped" ? "finished" : loop.stopReason
    const summary = stopReason === "refusal" ? "" : (toolbox.summary ?? (stopReason === "end_turn" ? loop.text : ""))
    return { summary, stopReason, transcript: compactTranscript(messages, summary || "(no answer)") }
}
