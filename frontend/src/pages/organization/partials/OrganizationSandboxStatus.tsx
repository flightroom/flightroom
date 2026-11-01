import { Card, CardContent, CardDescription, CardHeader, CardTitle, Spinner } from "@flightroom/design-system"
import { format } from "date-fns"
import { Container } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Badge, type IBadgeProps } from "@/components/atoms"
import { type AiSandboxStatus, useAiSandboxStatusQuery } from "@/hooks/apiClients/useAiSandboxApi"
import useThemeStore from "@/store/useThemeStore"

const BADGE_VARIANTS: Record<AiSandboxStatus, IBadgeProps["variant"]> = {
    online: "success",
    degraded: "warning",
    offline: "destructive",
    notConfigured: "outline"
}

interface OrganizationSandboxStatusProps {
    organizationId: string
}

/** Whether the OpenShell gateway, where Edit with AI installs, builds and tests, is up: one for the whole console */
export const OrganizationSandboxStatus: React.FC<OrganizationSandboxStatusProps> = ({ organizationId }) => {
    const { t } = useTranslation()
    const themeStore = useThemeStore()
    const statusQuery = useAiSandboxStatusQuery(organizationId)
    const summary = statusQuery.data

    return (
        <Card data-testid="ai-sandbox-status">
            <CardHeader className="flex-row items-start justify-between gap-3">
                <div className="min-w-0">
                    <CardTitle className="mb-0 flex items-center gap-2">
                        <Container className="size-5" aria-hidden="true" />
                        {t("ai_sandbox.title")}
                    </CardTitle>
                    <CardDescription>{t("ai_sandbox.description")}</CardDescription>
                </div>
                {statusQuery.isPending ? (
                    <Spinner size={16} centerScreen={false} label={t("common.loading")} />
                ) : summary ? (
                    <Badge variant={BADGE_VARIANTS[summary.status]} dataTestId={`ai-sandbox-${summary.status}`}>
                        {t(`ai_sandbox.status.${summary.status}`)}
                    </Badge>
                ) : null}
            </CardHeader>
            {!statusQuery.isPending && (
                <CardContent className="pt-0 text-sm text-foreground-secondary">
                    {summary ? (
                        <p>
                            {t(`ai_sandbox.hint.${summary.status}`)} {summary.version && `${t("ai_sandbox.version", { version: summary.version })} · `}
                            {t("ai_sandbox.checked_at", { time: format(new Date(summary.checkedAt), "p", { locale: themeStore.getLocale() }) })}
                        </p>
                    ) : (
                        <p>{t("ai_sandbox.errors.load")}</p>
                    )}
                </CardContent>
            )}
        </Card>
    )
}
