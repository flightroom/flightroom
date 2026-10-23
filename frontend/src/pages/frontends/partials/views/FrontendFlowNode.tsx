import { Handle, type Node, type NodeProps, Position } from "@xyflow/react"
import { LayoutDashboard } from "lucide-react"
import { useTranslation } from "react-i18next"
import WorkingAgentsIndicator, { useWorkingAgents } from "@/components/ai-agents/WorkingAgentsIndicator"
import { Badge } from "@/components/atoms"
import TechnologyLogo from "@/components/technology/TechnologyLogo"
import { CanaryType, type Frontend, FrontendKind } from "@/hooks/apiClients/useFrontendsApi"
import { cn } from "@/utils/styleUtils"
import { frontendTechnologyOf } from "@/utils/technologies"
import CloneRepositoryPopover from "../components/CloneRepositoryPopover"
import FrontendKindBadge from "../components/FrontendKindBadge"
import { CANARY_DEPLOYMENT_TYPE_LABEL_KEYS, CANARY_TYPE_LABEL_KEYS } from "../labels"

/**
 * The node carries the frontend itself and nothing derived from it: every label is translated
 * here, at render time, so switching language does not rebuild the graph — which would throw away
 * the positions dragged in this session, since they are only persisted on drag end.
 */
export interface FrontendNodeData extends Record<string, unknown> {
    frontend: Frontend
    /** Drawn beside backend services (the domain diagram): a primary stripe and icon tell it apart from them. */
    showKind?: boolean
}

export type FrontendFlowNodeType = Node<FrontendNodeData, "frontend">

export const FRONTEND_NODE_TYPE = "frontend"

/**
 * A handle small enough not to read as content, with a hit area larger than what it draws so it is
 * still comfortable to grab. React Flow gives handles their own stylesheet, hence the overrides.
 */
const HANDLE_CLASS =
    "!h-2 !w-2 !rounded-full !border-2 !border-card !bg-foreground-secondary/60 !transition-colors group-[.is-highlighted]:!bg-primary after:absolute after:-inset-2 after:content-['']"

export const FrontendFlowNode: React.FC<NodeProps<FrontendFlowNodeType>> = ({ data }) => {
    const { t } = useTranslation("platform")
    const { frontend, showKind } = data
    const canary = frontend.canary?.enabled ? frontend.canary : undefined
    const agents = useWorkingAgents(frontend._id)
    const technology = frontendTechnologyOf(frontend)

    // A share for the two strategies that split traffic, and who for the one that does not.
    const canaryLabel = canary && (canary.type === CanaryType.ON_USER ? t("frontend.canary_enrolled_users") : `${Math.min(100, Math.max(0, canary.percentage ?? 0))}%`)

    // Everything the chips leave out, so the graph stays readable while still answering the question
    // a hover asks: which build is this rolling out, and to whom.
    const canaryTitle = canary
        ? [
              t("frontend.card.canary"),
              canary.type && t(CANARY_TYPE_LABEL_KEYS[canary.type]),
              canary.deploymentType && t(CANARY_DEPLOYMENT_TYPE_LABEL_KEYS[canary.deploymentType]),
              canary.version || canary.url
          ]
              .filter(Boolean)
              .join(" · ")
        : undefined

    return (
        <div
            className={cn(
                "w-60 overflow-hidden rounded-lg border-2 border-border bg-card text-left shadow-sm transition-colors group-[.is-highlighted]:border-primary",
                showKind && "border-l-4 border-l-primary",
                agents > 0 && "animate-agent-glow border-primary motion-reduce:animate-none"
            )}
        >
            {/* A DOCKER is served by its own container and cannot be the remote of a host: nothing may link into it. */}
            {frontend.kind !== FrontendKind.DOCKER && <Handle type="target" position={Position.Top} className={HANDLE_CLASS} />}

            <div className="flex items-start gap-2 px-3 pt-2.5">
                {showKind && <LayoutDashboard className="mt-0.5 size-4 shrink-0 text-primary-strong" aria-hidden="true" />}
                {technology && <TechnologyLogo technology={technology} className="mt-0.5" />}
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-card-foreground" title={frontend.name}>
                        {frontend.name}
                    </div>
                    <div className="truncate text-xs text-foreground-secondary" title={frontend.slug}>
                        {frontend.slug}
                    </div>
                </div>
                {/* nodrag/nopan keep React Flow from turning the click into a drag; stopPropagation keeps a
                    double click from opening the frontend behind the popover. */}
                <span className="nodrag nopan shrink-0" onDoubleClick={event => event.stopPropagation()}>
                    <CloneRepositoryPopover frontend={frontend} iconOnly />
                </span>
            </div>

            {/* A row of its own, so a canary chip cannot make one node taller than the node beside it. */}
            <div className="mt-2 flex h-9 items-center gap-1.5 border-t border-divider px-3">
                <FrontendKindBadge frontend={frontend} className="shrink-0" />
                <Badge variant="outline" className="shrink-0" title={t("frontend.card.version", { version: frontend.version || "—" })}>
                    {frontend.version || "—"}
                </Badge>
                {canaryLabel && (
                    <Badge className="min-w-0" title={canaryTitle}>
                        <span className="truncate">
                            {t("frontend.card.canary")} {canaryLabel}
                        </span>
                    </Badge>
                )}
                <WorkingAgentsIndicator agents={agents} compact className="ml-auto" />
            </div>

            <Handle type="source" position={Position.Bottom} className={HANDLE_CLASS} />
        </div>
    )
}

export default FrontendFlowNode
