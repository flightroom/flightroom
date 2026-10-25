import { Info, Settings, Sparkles } from "lucide-react"
import { useTranslation } from "react-i18next"
import WorkspaceHeader from "@/components/ai-workspace/WorkspaceHeader"
import LivePreviewButton from "@/components/LivePreviewButton"
import type { Domain } from "@/hooks/apiClients/useDomainsApi"
import useAiShellPreviewUrl from "@/hooks/useAiShellPreviewUrl"
import DomainBuildAndDeployButton from "./DomainBuildAndDeployDialog"

interface DomainHeaderProps {
    domain: Domain
    /** The screens of a domain: Edit with AI, its landing screen, its overview, and its details and settings. */
    active: "ai" | "overview" | "settings"
}

/**
 * The header of the domain workspace, in the same frame as those of a frontend and of a backend, with the build and deploy of the domain,
 * the deploy alone, that ships the versions already set, and the build alone, that only tags its repositories.
 */
export const DomainHeader: React.FC<DomainHeaderProps> = ({ domain, active }) => {
    const { t } = useTranslation()
    const livePreview = useAiShellPreviewUrl({ kind: "domain", id: domain._id })

    return (
        <WorkspaceHeader
            back={{ to: "/domains", label: t("domains.detail.back") }}
            title={domain.name}
            pageTitle={t(active === "ai" ? "domains.ai.open" : active === "settings" ? "domains.workspace.nav_settings" : "domains.workspace.nav_overview")}
            meta={
                <>
                    <span className="font-mono">{domain.slug}</span>
                    {domain.description && <span>{domain.description}</span>}
                </>
            }
            navLabel={t("domains.workspace.nav_label")}
            // Edit with AI is always there: without an AI provider the workspace says so.
            tabs={[
                { to: `/domain/${domain._id}`, label: t("domains.ai.open"), icon: Sparkles, end: true },
                { to: `/domain/${domain._id}/overview`, label: t("domains.workspace.nav_overview"), icon: Info },
                { to: `/domain/${domain._id}/settings`, label: t("domains.workspace.nav_settings"), icon: Settings }
            ]}
            actions={
                <>
                    <LivePreviewButton url={livePreview.url} isPending={livePreview.isPending} />
                    <DomainBuildAndDeployButton domain={domain} />
                </>
            }
        />
    )
}

export default DomainHeader
