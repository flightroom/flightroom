import { lazy, Suspense } from "react"
import ErrorBoundary from "@/components/ErrorBoundary"
import { cn } from "@/utils/styleUtils"

const AssistantMarkdown = lazy(() => import("./AssistantMarkdown"))

/**
 * The text of a message or of a summary, rendered as Markdown with line breaks kept: summaries
 * become pull request descriptions, so the agent writes them for a Markdown renderer.
 *
 * The renderer loads the first time a message shows: until then, or if its chunk fails to load,
 * the text is there as written.
 */
const AssistantMessageText: React.FC<{ text: string; className?: string }> = ({ text, className }) => {
    const plainText = <p className="whitespace-pre-wrap">{text}</p>

    return (
        <div className={cn("flex flex-col gap-2 break-words", className)}>
            <ErrorBoundary fallback={plainText}>
                <Suspense fallback={plainText}>
                    <AssistantMarkdown text={text} />
                </Suspense>
            </ErrorBoundary>
        </div>
    )
}

export default AssistantMessageText
