import { useTranslation } from "react-i18next"
import { Badge } from "@/components/atoms"
import TechnologyBadge from "@/components/technology/TechnologyBadge"
import type { Backend } from "@/hooks/apiClients/useBackendsApi"
import { backendTechnologyOf } from "@/utils/technologies"
import { scheduleLabel } from "./BackendScheduleCard"
import { RUNTIME_LABEL_KEYS } from "./labels"

/** A backend on a schedule says when it runs: it is no service always answering */
export const ScheduleBadge: React.FC<{ backend: Backend }> = ({ backend }) => {
    const { t, i18n } = useTranslation()
    if (!backend.schedule) return null
    return (
        <Badge variant="outline" title={backend.schedule}>
            {t("backends.schedule.badge", { when: scheduleLabel(backend.schedule, t, i18n.language) })}
        </Badge>
    )
}

/** The runtime, with the logo of the technology when the stack says which one it is. */
export const RuntimeBadge: React.FC<{ backend: Backend }> = ({ backend }) => {
    const { t } = useTranslation()
    const runtime = backend.stack?.runtime
    const technology = backendTechnologyOf(backend)
    const runtimeLabel = runtime ? t(RUNTIME_LABEL_KEYS[runtime] ?? RUNTIME_LABEL_KEYS.OTHER) : undefined
    if (technology) return <TechnologyBadge technology={technology}>{runtimeLabel}</TechnologyBadge>
    if (!runtimeLabel) return null
    return <Badge variant="outline">{runtimeLabel}</Badge>
}

export default RuntimeBadge
