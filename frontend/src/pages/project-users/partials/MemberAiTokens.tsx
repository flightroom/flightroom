import { useTranslation } from "react-i18next"
import CostChip from "@/components/assistant/CostChip"
import { ProjectUser } from "@/hooks/apiClients/useProjectUserApi"
import { cn } from "@/utils/styleUtils"

/** The AI tokens the member spent in the project this month, against their monthly limit when they have one, and what they cost when the AIs have prices */
export const MemberAiTokens: React.FC<{ user: ProjectUser }> = ({ user }) => {
    const { t, i18n } = useTranslation()
    // Not given to whoever cannot see it
    if (user.aiTokensSpent === undefined) return null

    const format = (value: number) => value.toLocaleString(i18n.language)
    const limit = user.aiTokenLimit
    const reached = limit !== undefined && limit !== null && user.aiTokensSpent >= limit

    return (
        <span className="inline-flex flex-wrap items-center gap-1">
            <span className={cn("text-sm", reached ? "text-destructive" : "text-foreground-secondary")} title={t("project_users.ai_tokens.hint")} data-testid={`member-ai-tokens-${user.email}`}>
                {limit === undefined || limit === null
                    ? t("project_users.ai_tokens.spent_unlimited", { spent: format(user.aiTokensSpent) })
                    : t("project_users.ai_tokens.spent_of_limit", { spent: format(user.aiTokensSpent), limit: format(limit) })}
            </span>
            {user.aiCostsSpent?.map(cost => (
                <span key={cost.currency} title={t("project_users.ai_tokens.cost_hint")}>
                    <CostChip amount={cost.amount} currency={cost.currency} maximumFractionDigits={2} dataTestId={`member-ai-cost-${user.email}-${cost.currency}`} />
                </span>
            ))}
        </span>
    )
}

export default MemberAiTokens
