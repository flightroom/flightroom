import { lazy, Suspense } from "react"
import { cn } from "@/utils/styleUtils"

const AssistantMarkdown = lazy(() => import("./AssistantMarkdown"))

/**
 * The text of a message or of a summary, rendered as Markdown with line breaks kept: summaries
 * become pull request descriptions, so the agent writes them for a Markdown renderer.
 *
 * The renderer loads the first time a message shows: until then the text is there as written.
 */
const AssistantMessageText: React.FC<{ text: string; className?: string }> = ({ text, className }) => (
    <div className={cn("flex flex-col gap-2 break-words", className)}>
        <Suspense fallback={<p className="whitespace-pre-wrap">{text}</p>}>
            <AssistantMarkdown text={text} />
        </Suspense>
    </div>
)

export default AssistantMessageText
