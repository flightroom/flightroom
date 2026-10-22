import { useTranslation } from "react-i18next"
import { Badge } from "@/components/atoms"
import TechnologyBadge from "@/components/technology/TechnologyBadge"
import type { Service } from "@/hooks/apiClients/useServicesApi"
import { backendTechnologyOf } from "@/utils/technologies"
import { RUNTIME_LABEL_KEYS } from "./labels"

/** The runtime, with the logo of the technology when the stack says which one it is. */
export const RuntimeBadge: React.FC<{ service: Service }> = ({ service }) => {
    const { t } = useTranslation()
    const runtime = service.stack?.runtime
    const technology = backendTechnologyOf(service)
    const runtimeLabel = runtime ? t(RUNTIME_LABEL_KEYS[runtime] ?? RUNTIME_LABEL_KEYS.OTHER) : undefined
    if (technology) return <TechnologyBadge technology={technology}>{runtimeLabel}</TechnologyBadge>
    if (!runtimeLabel) return null
    return <Badge variant="outline">{runtimeLabel}</Badge>
}

export default RuntimeBadge
