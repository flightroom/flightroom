import { Info, Settings, Sparkles } from "lucide-react"
import { useTranslation } from "react-i18next"
import { ComponentWorkingAgents } from "@/components/ai-agents/WorkingAgentsIndicator"
import WorkspaceHeader from "@/components/ai-workspace/WorkspaceHeader"
import useProjectAiModels from "@/components/assistant/useProjectAiModels"
import { Badge } from "@/components/atoms"
import RepositoryLink from "@/components/RepositoryLink"
import TemplateRepositoryLink from "@/components/TemplateRepositoryLink"
import type { Backend } from "@/hooks/apiClients/useBackendsApi"
import RuntimeBadge from "./RuntimeBadge"

interface BackendHeaderProps {
    backend: Backend
    /** The screens of a backend: its overview, Edit with AI (when available) and its settings. */
    active: "overview" | "ai" | "settings"
    actions?: React.ReactNode
}

/** Edit with AI needs both an AI provider on the installation and a repository the agent can work on. */
export const isBackendAiAvailable = (backend: Backend | undefined, assistantEnabled: boolean) => assistantEnabled && Boolean(backend?.codeRepository?.enabled)

const PAGE_TITLE_KEY: Record<BackendHeaderProps["active"], string> = { overview: "backends.nav_overview", ai: "backends.nav_ai", settings: "backends.nav_settings" }

export const BackendHeader: React.FC<BackendHeaderProps> = ({ backend, active, actions }) => {
    const { t } = useTranslation()
    const aiAvailable = isBackendAiAvailable(backend, useProjectAiModels().enabled)

    return (
        <WorkspaceHeader
            back={{ to: "/backends", label: t("backends.back") }}
            title={backend.name}
            pageTitle={t(PAGE_TITLE_KEY[active])}
            meta={
                <>
                    <span className="font-mono">{backend.slug}</span>
                    <RuntimeBadge backend={backend} />
                    {backend.version && <Badge variant="outline">{t("backends.version_short", { version: backend.version })}</Badge>}
                    <RepositoryLink repository={backend.codeRepository} />
                    <TemplateRepositoryLink slug={backend.template} />
                    <ComponentWorkingAgents componentId={backend._id} live />
                </>
            }
            navLabel={t("backends.nav_label")}
            tabs={[
                ...(aiAvailable ? [{ to: `/backend/${backend._id}`, label: t("backends.nav_ai"), icon: Sparkles, end: true }] : []),
                { to: `/backend/${backend._id}/overview`, label: t("backends.nav_overview"), icon: Info },
                { to: `/backend/${backend._id}/settings`, label: t("backends.nav_settings"), icon: Settings }
            ]}
            actions={actions}
        />
    )
}

export default BackendHeader
