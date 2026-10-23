import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@flightroom/design-system"
import { Cog, Sparkles } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { ComponentWorkingAgents } from "@/components/ai-agents/WorkingAgentsIndicator"
import useProjectAiModels from "@/components/assistant/useProjectAiModels"
import { Badge, Button } from "@/components/atoms"
import RepositoryLink from "@/components/RepositoryLink"
import type { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import type { Service } from "@/hooks/apiClients/useServicesApi"
import { isAiEditAvailable } from "@/pages/frontends/partials/components"
import FrontendBadge from "./FrontendBadge"
import RuntimeBadge from "./RuntimeBadge"
import { isServiceAiAvailable } from "./ServiceHeader"

/** Services, or frontends served by their own container: these open on their frontend pages. */
export const ServicesGrid: React.FC<{ services?: Service[]; frontends?: Frontend[] }> = ({ services = [], frontends = [] }) => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const assistantEnabled = useProjectAiModels().enabled

    return (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-4">
            {services.map(service => {
                // The whole card opens on Edit with AI, as a frontend does, when the agent can work on the service.
                const aiAvailable = isServiceAiAvailable(service, assistantEnabled)
                return (
                    <Card
                        key={service._id}
                        className="flex h-full cursor-pointer flex-col transition-colors duration-200 hover:border-primary"
                        onClick={() => navigate(aiAvailable ? `/service/${service._id}` : `/service/${service._id}/overview`)}
                    >
                        <CardHeader className="flex-row items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                                <CardTitle className="mb-0 truncate" title={service.name}>
                                    {service.name}
                                </CardTitle>
                                <p className="truncate text-sm text-foreground-secondary" title={service.slug}>
                                    {service.slug}
                                </p>
                                <ComponentWorkingAgents componentId={service._id} className="mt-2 max-w-full" />
                            </div>
                            {service.version && <Badge className="shrink-0">{service.version}</Badge>}
                        </CardHeader>
                        <CardContent className="flex flex-grow flex-col items-start gap-3 py-3 text-sm">
                            <RuntimeBadge service={service} />
                            <RepositoryLink repository={service.codeRepository} />
                        </CardContent>
                        <CardFooter className="border-t border-divider pt-3">
                            {/* Its click reaches the card, which opens: the button keeps the card reachable from the keyboard */}
                            <Button variant="primary" size="sm" className="flex-1">
                                {aiAvailable ? <Sparkles /> : <Cog />}
                                {aiAvailable ? t("services.nav_ai") : t("services.list.open")}
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
                        onClick={() => navigate(aiAvailable ? `/frontend/${frontend._id}` : `/frontend/${frontend._id}/settings`)}
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
                                {aiAvailable ? t("frontend.workspace.nav_ai") : t("services.list.open")}
                            </Button>
                        </CardFooter>
                    </Card>
                )
            })}
        </div>
    )
}

export default ServicesGrid
