import { Card, CardContent, CardDescription, CardHeader, CardTitle, StatTile } from "@flightroom/design-system"
import { format } from "date-fns"
import { Container } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Badge, type IBadgeProps } from "@/components/atoms"
import type { AiSandboxStatus } from "@/hooks/apiClients/useAiSandboxApi"
import type { SandboxSettingsSummary } from "@/hooks/apiClients/useInstallationApi"
import useThemeStore from "@/store/useThemeStore"

const BADGE_VARIANTS: Record<AiSandboxStatus, IBadgeProps["variant"]> = {
    online: "success",
    degraded: "warning",
    offline: "destructive",
    notConfigured: "outline"
}

interface SandboxPoolStatusProps {
    summary: SandboxSettingsSummary
}

/** Whether the OpenShell gateway answers, and how many sandboxes wait warm, are being created for the pool, or serve a key. */
export const SandboxPoolStatus: React.FC<SandboxPoolStatusProps> = ({ summary }) => {
    const { t } = useTranslation()
    const themeStore = useThemeStore()
    const { gateway, pool } = summary

    return (
        <Card data-testid="installation-sandbox-status">
            <CardHeader className="flex-row items-start justify-between gap-3">
                <div className="min-w-0">
                    <CardTitle className="mb-0 flex items-center gap-2">
                        <Container className="size-5" aria-hidden="true" />
                        {t("ai_sandbox.title")}
                    </CardTitle>
                    <CardDescription>
                        {t(`ai_sandbox.hint.${gateway.status}`)} {gateway.version && `${t("ai_sandbox.version", { version: gateway.version })} · `}
                        {t("ai_sandbox.checked_at", { time: format(new Date(gateway.checkedAt), "p", { locale: themeStore.getLocale() }) })}
                    </CardDescription>
                </div>
                <Badge variant={BADGE_VARIANTS[gateway.status]} dataTestId={`installation-gateway-${gateway.status}`}>
                    {t(`ai_sandbox.status.${gateway.status}`)}
                </Badge>
            </CardHeader>
            <CardContent className="grid gap-3 pt-0 sm:grid-cols-3">
                <StatTile label={t("installation.pool.warm")} labelAs="h3" value={pool.warm} dataTestId="installation-pool-warm" />
                <StatTile label={t("installation.pool.creating")} labelAs="h3" value={pool.creating} dataTestId="installation-pool-creating" />
                <StatTile label={t("installation.pool.assigned")} labelAs="h3" value={pool.assigned} dataTestId="installation-pool-assigned" />
                <p className="text-sm text-foreground-secondary sm:col-span-3">{t("installation.pool.hint")}</p>
            </CardContent>
        </Card>
    )
}

export default SandboxPoolStatus
