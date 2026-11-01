import { Info, Settings, Sparkles } from "lucide-react"
import { useTranslation } from "react-i18next"
import { ComponentWorkingAgents } from "@/components/ai-agents/WorkingAgentsIndicator"
import WorkspaceHeader from "@/components/ai-workspace/WorkspaceHeader"
import useProjectAiModels from "@/components/assistant/useProjectAiModels"
import CloneRepositoryPopover from "@/components/CloneRepositoryPopover"
import LivePreviewButton from "@/components/LivePreviewButton"
import TemplateRepositoryLink from "@/components/TemplateRepositoryLink"
import type { Backend } from "@/hooks/apiClients/useBackendsApi"
import useLivePreview from "@/hooks/useLivePreview"
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
    const livePreview = useLivePreview({ kind: "backend", id: backend._id })

    return (
        <WorkspaceHeader
            back={{ to: "/backends", label: t("backends.back") }}
            title={backend.name}
            pageTitle={t(PAGE_TITLE_KEY[active])}
            meta={
                <>
                    {/* No version: each environment runs its own */}
                    <RuntimeBadge backend={backend} />
                    <CloneRepositoryPopover frontend={backend} link />
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
            actions={
                <>
                    <LivePreviewButton start={livePreview.start} isPending={livePreview.isPending} />
                    {actions}
                </>
            }
        />
    )
}

export default BackendHeader
