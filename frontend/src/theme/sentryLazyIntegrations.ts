// Loaded on its own chunk by SentryInit: session replay and the feedback widget are most of the SDK,
// and neither is needed to report the first errors. Importing them from "@sentry/react" in SentryInit
// would put them back in the entry chunk.
// Trade-off: a replay starts once this chunk has loaded, so it does not cover the boot before it.
export { feedbackIntegration, replayIntegration } from "@sentry/react"
