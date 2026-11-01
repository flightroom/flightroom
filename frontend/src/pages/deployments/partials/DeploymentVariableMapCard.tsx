import { Card, CardContent, CardHeader, CardTitle } from "@flightroom/design-system"
import { KeyRound, SlidersHorizontal } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { Badge } from "@/components/atoms"
import { DeployedVariableMap } from "@/hooks/apiClients/useDeploymentsApi"
import { VariableMapKind } from "@/hooks/apiClients/useVariableMapsApi"
import { VARIABLE_MAP_KINDS } from "@/pages/variable-maps/partials/variableMaps"
import { cn } from "@/utils/styleUtils"

const KIND_STYLE: Record<VariableMapKind, { icon: React.ReactNode; badge: "warning" | "success"; border: string }> = {
    configMap: { icon: <SlidersHorizontal className="size-3" aria-hidden="true" />, badge: "warning", border: "border-l-warning" },
    secret: { icon: <KeyRound className="size-3" aria-hidden="true" />, badge: "success", border: "border-l-success" }
}

interface DeploymentVariableMapCardProps {
    kind: VariableMapKind
    deployed: DeployedVariableMap
}

export const DeploymentVariableMapCard: React.FC<DeploymentVariableMapCardProps> = ({ kind, deployed }) => {
    const { t } = useTranslation()
    const style = KIND_STYLE[kind]
    const keys = deployed.entries.map(entry => entry.key)

    return (
        // The name is the link; it stretches over the whole card, so the card opens the map on a click anywhere.
        <Card className={cn("relative border-l-4 transition-colors duration-200 focus-within:border-primary hover:border-primary", style.border)}>
            <CardHeader className="border-0 pb-0">
                <Badge variant={style.badge} className="mb-2 w-fit">
                    {style.icon}
                    {t(`deployments.kind_${kind}`)}
                </Badge>
                <CardTitle className="mb-0 text-base truncate" title={deployed.name}>
                    <Link
                        to={VARIABLE_MAP_KINDS[kind].detailPath(deployed._id)}
                        className="underline-offset-4 hover:underline after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
                    >
                        {deployed.name}
                    </Link>
                </CardTitle>
            </CardHeader>
            {/* The keys it set in the environment, by name only: the values are on its page */}
            <CardContent className="pt-1">
                <p className="text-sm text-foreground-secondary truncate" title={keys.join(", ")}>
                    {keys.length > 0 ? t("deployments.map_keys", { count: keys.length }) : t("deployments.map_no_keys")}
                </p>
            </CardContent>
        </Card>
    )
}

export default DeploymentVariableMapCard
