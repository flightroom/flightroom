import { z } from "zod"
import AiUsageService, { MAX_DAILY_SPAN_DAYS } from "../../service/AiUsageService"
import { MCP_SCOPE_READ } from "../../utils/oauthConfig"
import { defineTool, objectId, READ_ONLY } from "../toolDefinition"

/** The zones MongoDB knows are the IANA ones, as the runtime's: an unknown one is refused before the query. */
const isTimeZone = (zone: string) => {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone })
        return true
    } catch {
        return false
    }
}

/** The AI tokens spent in the project, by the assistant and Edit with AI, read by MCP clients too. */
export const aiUsageTools = [
    defineTool({
        name: "user_ai_usage",
        title: "Get a user's AI usage",
        description: `The AI tokens one person spent in the project, by the assistant and Edit with AI, between two days (both included), summed by day, ISO week (e.g. 2026-W43, Monday first) or month. Each period has inputTokens (cachedInputTokens is the part of them read from the prompt cache, billed at a fraction) and outputTokens; periods with no usage are left out; total adds them all. Name the person by userId or by the email they sign in with. Everyone sees their own; the others' only an owner of the project or an administrator of its organization. A daily series spans at most ${MAX_DAILY_SPAN_DAYS} days.`,
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z
            .object({
                userId: objectId("Id of the user").optional(),
                email: z.email().optional().describe("In place of userId: the email the person signs in with"),
                from: z.iso.date().describe("The first day counted, YYYY-MM-DD"),
                to: z.iso.date().describe("The last day counted, included, YYYY-MM-DD"),
                granularity: z.enum(["day", "week", "month"]).default("day").describe("What the tokens are summed by: day (the default), week or month"),
                timeZone: z
                    .string()
                    .trim()
                    .max(64)
                    .refine(isTimeZone, "must be an IANA time zone, e.g. Europe/Rome")
                    .optional()
                    .describe("The IANA time zone the days begin in, e.g. Europe/Rome; UTC when left out")
            })
            .refine(args => Boolean(args.userId) !== Boolean(args.email), { message: "Pass userId or email, one of them" }),
        run: ({ userId, email, ...query }, { principal, projectId }) => new AiUsageService(principal).forMember(projectId, userId ? { userId } : { email: email! }, query)
    })
]
