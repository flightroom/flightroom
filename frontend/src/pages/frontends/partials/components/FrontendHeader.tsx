import { Info, Settings, Sparkles } from "lucide-react"
import { useTranslation } from "react-i18next"
import { ComponentWorkingAgents } from "@/components/ai-agents/WorkingAgentsIndicator"
import WorkspaceHeader from "@/components/ai-workspace/WorkspaceHeader"
import { Badge } from "@/components/atoms"
import LivePreviewButton from "@/components/LivePreviewButton"
import RepositoryLink from "@/components/RepositoryLink"
import TemplateRepositoryLink from "@/components/TemplateRepositoryLink"
import TechnologyBadge from "@/components/technology/TechnologyBadge"
import type { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import useAiShellPreviewUrl from "@/hooks/useAiShellPreviewUrl"
import { frontendTechnologyOf } from "@/utils/technologies"

/** Edit with AI needs both an AI provider on the installation and a repository the agent can work on. */
export const isAiEditAvailable = (frontend: Frontend | undefined, assistantEnabled: boolean) => assistantEnabled && Boolean(frontend?.codeRepository?.enabled)

interface FrontendHeaderProps {
    frontend: Frontend
    /** The screens of a frontend, as a backend's: Edit with AI (when available), its overview and its settings. */
    active: "ai" | "overview" | "settings"
    aiAvailable: boolean
    actions?: React.ReactNode
}

const PAGE_TITLE_KEY: Record<FrontendHeaderProps["active"], string> = { ai: "frontend.workspace.nav_ai", overview: "frontend.workspace.nav_overview", settings: "frontend.workspace.nav_settings" }

/** Shared by the screens of a frontend, so switching between them keeps the same frame. */
export const FrontendHeader: React.FC<FrontendHeaderProps> = ({ frontend, active, aiAvailable, actions }) => {
    const { t } = useTranslation()
    const technology = frontendTechnologyOf(frontend)
    const livePreview = useAiShellPreviewUrl({ kind: "frontend", frontend })

    return (
        <WorkspaceHeader
            back={{ to: "/frontends", label: t("frontend.workspace.back") }}
            title={frontend.name}
            pageTitle={t(PAGE_TITLE_KEY[active])}
            meta={
                <>
                    <span className="font-mono">{frontend.slug}</span>
                    {technology && <TechnologyBadge technology={technology} />}
                    {frontend.version && <Badge variant="outline">{t("frontend.workspace.version", { version: frontend.version })}</Badge>}
                    <RepositoryLink repository={frontend.codeRepository} />
                    <TemplateRepositoryLink slug={frontend.template} />
                    <ComponentWorkingAgents componentId={frontend._id} live />
                </>
            }
            navLabel={t("frontend.workspace.nav_label")}
            tabs={[
                ...(aiAvailable ? [{ to: `/frontend/${frontend._id}`, label: t("frontend.workspace.nav_ai"), icon: Sparkles, end: true }] : []),
                { to: `/frontend/${frontend._id}/overview`, label: t("frontend.workspace.nav_overview"), icon: Info },
                { to: `/frontend/${frontend._id}/settings`, label: t("frontend.workspace.nav_settings"), icon: Settings }
            ]}
            actions={
                <>
                    <LivePreviewButton url={livePreview.url} isPending={livePreview.isPending} />
                    {actions}
                </>
            }
        />
    )
}

export default FrontendHeader
