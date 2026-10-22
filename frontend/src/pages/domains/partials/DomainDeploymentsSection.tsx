import { ColorSwatch } from "@flightroom/design-system"
import { format } from "date-fns"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/atoms"
import { DeployedFrontend, EnvironmentDeployment } from "@/hooks/apiClients/useDomainDeploymentsApi"
import { CanaryType } from "@/hooks/apiClients/useFrontendsApi"
import useThemeStore from "@/store/useThemeStore"

interface DeployedVersionProps {
    version: string | null
    canary?: DeployedFrontend["canary"]
    /** Shown when there is no version: the frontend was not deployed, the backend was not reported */
    emptyLabel: string
}

/** A version as deployed, e.g. `1.2.0 · canary 3.0.0 (10%)`, or the empty label when there is none */
export const DeployedVersion: React.FC<DeployedVersionProps> = ({ version, canary, emptyLabel }) => {
    const { t } = useTranslation()
    if (!version) {
        return <span className="italic text-foreground-secondary">{emptyLabel}</span>
    }
    // ON_USER ignores the percentage: the canary goes to the users enrolled on the deployment
    const audience = canary && (canary.type === CanaryType.ON_USER ? t("domains.deployments.canary_enrolled_users") : `${canary.percentage}%`)
    return (
        <span className="font-mono text-xs">
            {version}
            {canary && ` · ${canary.version ? t("domains.deployments.canary", { version: canary.version, audience }) : t("domains.deployments.canary_without_version", { audience })}`}
        </span>
    )
}

/** Name and colour of an environment, with the deployment it serves */
export const EnvironmentHeading: React.FC<{ entry: EnvironmentDeployment }> = ({ entry }) => {
    const { t } = useTranslation()
    const themeStore = useThemeStore()
    return (
        <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-2 font-medium">
                <ColorSwatch size="sm" color={entry.environment.color} />
                <span className="truncate">{entry.environment.name}</span>
                {entry.environment.isProduction && <Badge className="shrink-0">{t("domains.deployments.production")}</Badge>}
            </span>
            <span className="text-xs font-normal text-foreground-secondary">
                {entry.deployment
                    ? t("domains.deployments.deployment", {
                          deploymentId: entry.deployment.deploymentId,
                          date: format(new Date(entry.deployment.deployedAt), "PPp", { locale: themeStore.getLocale() })
                      })
                    : t("domains.deployments.never_deployed")}
            </span>
        </div>
    )
}
