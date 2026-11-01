import { EntityCard } from "@flightroom/design-system"
import { Info, Settings, Sparkles } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import WorkingAgentsIndicator, { useWorkingAgents } from "@/components/ai-agents/WorkingAgentsIndicator"
import useProjectAiModels from "@/components/assistant/useProjectAiModels"
import { Badge, Button } from "@/components/atoms"
import RepositoryLink from "@/components/RepositoryLink"
import TechnologyLogo from "@/components/technology/TechnologyLogo"
import type { Backend } from "@/hooks/apiClients/useBackendsApi"
import type { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import { FrontendCard } from "@/pages/frontends/partials/components"
import { cn } from "@/utils/styleUtils"
import { backendTechnologyOf } from "@/utils/technologies"
import { isBackendAiAvailable } from "./BackendHeader"
import RuntimeBadge from "./RuntimeBadge"

/** The screens of the backend, as in its header: the same card as a frontend's and a domain's */
const BackendCard: React.FC<{ backend: Backend; assistantEnabled: boolean }> = ({ backend, assistantEnabled }) => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const agents = useWorkingAgents(backend._id)
    const technology = backendTechnologyOf(backend)

    return (
        <EntityCard
            name={backend.name}
            subtitle={backend.slug}
            logo={technology && <TechnologyLogo technology={technology} />}
            status={agents > 0 && <WorkingAgentsIndicator agents={agents} className="max-w-full" />}
            badges={
                <>
                    {backend.version && <Badge>{backend.version}</Badge>}
                    <RuntimeBadge backend={backend} />
                </>
            }
            className={cn(agents > 0 && "animate-agent-glow border-primary motion-reduce:animate-none")}
            primaryAction={
                isBackendAiAvailable(backend, assistantEnabled) && (
                    <Button variant="primary" size="sm" onClick={() => navigate(`/backend/${backend._id}`)}>
                        <Sparkles />
                        {t("backends.nav_ai")}
                    </Button>
                )
            }
            actions={
                <>
                    <Button variant="secondary" size="sm" onClick={() => navigate(`/backend/${backend._id}/overview`)}>
                        <Info />
                        {t("backends.nav_overview")}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => navigate(`/backend/${backend._id}/settings`)}>
                        <Settings />
                        {t("backends.nav_settings")}
                    </Button>
                </>
            }
        >
            <RepositoryLink repository={backend.codeRepository} />
        </EntityCard>
    )
}

/** Backends, or frontends served by their own container: these get the card of a frontend. */
export const BackendsGrid: React.FC<{ backends?: Backend[]; frontends?: Frontend[] }> = ({ backends = [], frontends = [] }) => {
    const assistantEnabled = useProjectAiModels().enabled

    return (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-4">
            {backends.map(backend => (
                <BackendCard key={backend._id} backend={backend} assistantEnabled={assistantEnabled} />
            ))}
            {frontends.map(frontend => (
                <FrontendCard key={frontend._id} mfe={frontend} />
            ))}
        </div>
    )
}

export default BackendsGrid
