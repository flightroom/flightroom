import { LayoutDashboard } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/atoms"

/** Marks a frontend served by its own container among the services, where the runtime badge would go. */
export const FrontendBadge: React.FC = () => {
    const { t } = useTranslation()
    return (
        <Badge variant="outline" className="gap-1" title={t("frontend.kind.docker_description")}>
            <LayoutDashboard className="size-3 shrink-0" aria-hidden="true" />
            {t("services.list.frontendBadge")}
        </Badge>
    )
}

export default FrontendBadge
