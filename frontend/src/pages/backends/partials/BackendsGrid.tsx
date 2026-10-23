import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@flightroom/design-system"
import { Cog, Sparkles } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { ComponentWorkingAgents } from "@/components/ai-agents/WorkingAgentsIndicator"
import useProjectAiModels from "@/components/assistant/useProjectAiModels"
import { Badge, Button } from "@/components/atoms"
import RepositoryLink from "@/components/RepositoryLink"
import type { Backend } from "@/hooks/apiClients/useBackendsApi"
import type { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import { isAiEditAvailable } from "@/pages/frontends/partials/components"
import { isBackendAiAvailable } from "./BackendHeader"
import FrontendBadge from "./FrontendBadge"
import RuntimeBadge from "./RuntimeBadge"

/** Backends, or frontends served by their own container: these open on their frontend pages. */
export const BackendsGrid: React.FC<{ backends?: Backend[]; frontends?: Frontend[] }> = ({ backends = [], frontends = [] }) => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const assistantEnabled = useProjectAiModels().enabled

    return (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-4">
            {backends.map(backend => {
                // The whole card opens on Edit with AI, as a frontend does, when the agent can work on the backend.
                const aiAvailable = isBackendAiAvailable(backend, assistantEnabled)
                return (
                    <Card
                        key={backend._id}
                        className="flex h-full cursor-pointer flex-col transition-colors duration-200 hover:border-primary"
                        onClick={() => navigate(aiAvailable ? `/backend/${backend._id}` : `/backend/${backend._id}/overview`)}
                    >
                        <CardHeader className="flex-row items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                                <CardTitle className="mb-0 truncate" title={backend.name}>
                                    {backend.name}
                                </CardTitle>
                                <p className="truncate text-sm text-foreground-secondary" title={backend.slug}>
                                    {backend.slug}
                                </p>
                                <ComponentWorkingAgents componentId={backend._id} className="mt-2 max-w-full" />
                            </div>
                            {backend.version && <Badge className="shrink-0">{backend.version}</Badge>}
                        </CardHeader>
                        <CardContent className="flex flex-grow flex-col items-start gap-3 py-3 text-sm">
                            <RuntimeBadge backend={backend} />
                            <RepositoryLink repository={backend.codeRepository} />
                        </CardContent>
                        <CardFooter className="border-t border-divider pt-3">
                            {/* Its click reaches the card, which opens: the button keeps the card reachable from the keyboard */}
                            <Button variant="primary" size="sm" className="flex-1">
                                {aiAvailable ? <Sparkles /> : <Cog />}
                                {aiAvailable ? t("backends.nav_ai") : t("backends.list.open")}
                            </Button>
                        </CardFooter>
                    </Card>
                )
            })}
            {frontends.map(frontend => {
                const aiAvailable = isAiEditAvailable(frontend, assistantEnabled)
                return (
                    <Card
                        key={frontend._id}
                        className="flex h-full cursor-pointer flex-col transition-colors duration-200 hover:border-primary"
                        onClick={() => navigate(aiAvailable ? `/frontend/${frontend._id}` : `/frontend/${frontend._id}/overview`)}
                    >
                        <CardHeader className="flex-row items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                                <CardTitle className="mb-0 truncate" title={frontend.name}>
                                    {frontend.name}
                                </CardTitle>
                                <p className="truncate text-sm text-foreground-secondary" title={frontend.slug}>
                                    {frontend.slug}
                                </p>
                                <ComponentWorkingAgents componentId={frontend._id} className="mt-2 max-w-full" />
                            </div>
                            {frontend.version && <Badge className="shrink-0">{frontend.version}</Badge>}
                        </CardHeader>
                        <CardContent className="flex flex-grow flex-col items-start gap-3 py-3 text-sm">
                            <FrontendBadge />
                            <RepositoryLink repository={frontend.codeRepository} />
                        </CardContent>
                        <CardFooter className="border-t border-divider pt-3">
                            <Button variant="primary" size="sm" className="flex-1">
                                {aiAvailable ? <Sparkles /> : <Cog />}
                                {aiAvailable ? t("frontend.workspace.nav_ai") : t("backends.list.open")}
                            </Button>
                        </CardFooter>
                    </Card>
                )
            })}
        </div>
    )
}

export default BackendsGrid
