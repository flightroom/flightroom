import { Boxes } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/atoms"

/** The pods a deployed container runs in the environment of the deployment: none means it is stopped there */
export const DeploymentReplicas: React.FC<{ replicas: number }> = ({ replicas }) => {
    const { t } = useTranslation()

    return (
        <Badge variant="outline" className="w-fit" title={replicas === 0 ? t("deployments.card.stopped") : undefined}>
            <Boxes className="size-3" aria-hidden="true" />
            {t("deployments.card.replicas", { count: replicas })}
        </Badge>
    )
}

export default DeploymentReplicas
