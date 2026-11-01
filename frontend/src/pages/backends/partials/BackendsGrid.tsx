import { EntityCard } from "@flightroom/design-system"
import { Info, Settings, Sparkles } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import WorkingAgentsIndicator, { useWorkingAgents } from "@/components/ai-agents/WorkingAgentsIndicator"
import useProjectAiModels from "@/components/assistant/useProjectAiModels"
import EntityCardActions, { HIDE_EMPTY_CARD_BODY } from "@/components/EntityCardActions"
import TechnologyLogo from "@/components/technology/TechnologyLogo"
import type { Backend } from "@/hooks/apiClients/useBackendsApi"
import type { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import { CloneRepositoryPopover, FrontendCard } from "@/pages/frontends/partials/components"
import { cn } from "@/utils/styleUtils"
import { backendTechnologyOf } from "@/utils/technologies"
import { isBackendAiAvailable } from "./BackendHeader"

/** The screens of the backend, as in its header: the same card as a frontend's and a domain's */
const BackendCard: React.FC<{ backend: Backend; assistantEnabled: boolean }> = ({ backend, assistantEnabled }) => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const agents = useWorkingAgents(backend._id)
    const technology = backendTechnologyOf(backend)

    return (
        <EntityCard
            name={backend.name}
            logo={technology && <TechnologyLogo technology={technology} />}
            status={agents > 0 && <WorkingAgentsIndicator agents={agents} className="max-w-full" />}
            className={cn(HIDE_EMPTY_CARD_BODY, agents > 0 && "animate-agent-glow border-primary motion-reduce:animate-none")}
            actions={
                <EntityCardActions
                    actions={[
                        isBackendAiAvailable(backend, assistantEnabled) && { label: t("backends.nav_ai"), icon: <Sparkles />, onClick: () => navigate(`/backend/${backend._id}`), primary: true },
                        { label: t("backends.nav_overview"), icon: <Info />, onClick: () => navigate(`/backend/${backend._id}/overview`) },
                        { label: t("backends.nav_settings"), icon: <Settings />, onClick: () => navigate(`/backend/${backend._id}/settings`) }
                    ]}
                >
                    <CloneRepositoryPopover frontend={backend} tile />
                </EntityCardActions>
            }
        />
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
