import { Container, LayoutDashboard } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/atoms"
import { type Frontend, FrontendKind } from "@/hooks/apiClients/useFrontendsApi"
import { cn } from "@/utils/styleUtils"
import { KIND_BADGE_KEYS, KIND_DESCRIPTION_KEYS } from "../labels"

/** Who serves it, at a glance: Flightroom, or its own Docker container. */
export const FrontendKindBadge: React.FC<{ frontend: Frontend; className?: string }> = ({ frontend, className }) => {
    const { t } = useTranslation()
    const kind = frontend.kind ?? FrontendKind.BUNDLE
    const Icon = kind === FrontendKind.DOCKER ? Container : LayoutDashboard

    return (
        <Badge variant="outline" className={cn("gap-1", className)} title={t(KIND_DESCRIPTION_KEYS[kind])}>
            <Icon className="size-3 shrink-0" aria-hidden="true" />
            {t(KIND_BADGE_KEYS[kind])}
        </Badge>
    )
}

export default FrontendKindBadge
