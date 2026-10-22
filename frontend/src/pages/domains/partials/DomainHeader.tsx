import { Sparkles } from "lucide-react"
import { useTranslation } from "react-i18next"
import WorkspaceHeader from "@/components/ai-workspace/WorkspaceHeader"
import type { Domain } from "@/hooks/apiClients/useDomainsApi"
import DomainBuildButton from "./DomainBuildDialog"
import DomainDeployButton from "./DomainDeployDialog"

interface DomainHeaderProps {
    domain: Domain
}

/** The header of the domain workspace, in the same frame as those of a frontend and of a service, with the build and the deploy of the domain. */
export const DomainHeader: React.FC<DomainHeaderProps> = ({ domain }) => {
    const { t } = useTranslation()

    return (
        <WorkspaceHeader
            back={{ to: "/domains", label: t("domains.detail.back") }}
            title={domain.name}
            pageTitle={t("domains.ai.open")}
            meta={
                <>
                    <span className="font-mono">{domain.slug}</span>
                    {domain.description && <span>{domain.description}</span>}
                </>
            }
            navLabel={t("domains.workspace.nav_label")}
            // Edit with AI is always there: without an AI provider the workspace says so.
            tabs={[{ to: `/domain/${domain._id}`, label: t("domains.ai.open"), icon: Sparkles, end: true }]}
            actions={
                <>
                    <DomainBuildButton domain={domain} />
                    <DomainDeployButton domain={domain} />
                </>
            }
        />
    )
}

export default DomainHeader
