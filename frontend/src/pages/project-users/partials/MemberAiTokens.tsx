import { useTranslation } from "react-i18next"
import { ProjectUser } from "@/hooks/apiClients/useProjectUserApi"
import { cn } from "@/utils/styleUtils"

/** The AI tokens the member spent in the project this month, against their monthly limit when they have one */
export const MemberAiTokens: React.FC<{ user: ProjectUser }> = ({ user }) => {
    const { t, i18n } = useTranslation()
    // Not given to whoever cannot see it
    if (user.aiTokensSpent === undefined) return null

    const format = (value: number) => value.toLocaleString(i18n.language)
    const limit = user.aiTokenLimit
    const reached = limit !== undefined && limit !== null && user.aiTokensSpent >= limit

    return (
        <span className={cn("text-sm", reached ? "text-destructive" : "text-foreground-secondary")} title={t("project_users.ai_tokens.hint")} data-testid={`member-ai-tokens-${user.email}`}>
            {limit === undefined || limit === null
                ? t("project_users.ai_tokens.spent_unlimited", { spent: format(user.aiTokensSpent) })
                : t("project_users.ai_tokens.spent_of_limit", { spent: format(user.aiTokensSpent), limit: format(limit) })}
        </span>
    )
}

export default MemberAiTokens
