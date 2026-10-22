import { Info, Sparkles } from "lucide-react"
import { useTranslation } from "react-i18next"
import WorkspaceHeader from "@/components/ai-workspace/WorkspaceHeader"
import { Badge } from "@/components/atoms"
import RepositoryLink from "@/components/RepositoryLink"
import TemplateRepositoryLink from "@/components/TemplateRepositoryLink"
import type { Frontend } from "@/hooks/apiClients/useFrontendsApi"

/** Edit with AI needs both an AI provider on the installation and a repository the agent can work on. */
export const isAiEditAvailable = (frontend: Frontend | undefined, assistantEnabled: boolean) => assistantEnabled && Boolean(frontend?.codeRepository?.enabled)

interface FrontendHeaderProps {
    frontend: Frontend
    /** The two screens of a frontend: the AI workspace and its details. */
    active: "ai" | "settings"
    aiAvailable: boolean
}

/** Shared by the two screens of a frontend, so switching between them keeps the same frame. */
export const FrontendHeader: React.FC<FrontendHeaderProps> = ({ frontend, active, aiAvailable }) => {
    const { t } = useTranslation()

    return (
        <WorkspaceHeader
            back={{ to: "/frontends", label: t("frontend.workspace.back") }}
            title={frontend.name}
            pageTitle={active === "ai" ? t("frontend.workspace.nav_ai") : t("frontend.workspace.nav_settings")}
            meta={
                <>
                    <span className="font-mono">{frontend.slug}</span>
                    <Badge variant="outline">{t("frontend.workspace.version", { version: frontend.version || "—" })}</Badge>
                    <RepositoryLink repository={frontend.codeRepository} />
                    <TemplateRepositoryLink slug={frontend.template} />
                </>
            }
            navLabel={t("frontend.workspace.nav_label")}
            tabs={
                aiAvailable
                    ? [
                          { to: `/frontend/${frontend._id}`, label: t("frontend.workspace.nav_ai"), icon: Sparkles, end: true },
                          { to: `/frontend/${frontend._id}/settings`, label: t("frontend.workspace.nav_settings"), icon: Info }
                      ]
                    : []
            }
        />
    )
}

export default FrontendHeader
