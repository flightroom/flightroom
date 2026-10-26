import { useTranslation } from "react-i18next"
import { Badge } from "@/components/atoms"
import type { AiCurrency } from "@/hooks/apiClients/useAiModelsApi"

interface CostChipProps {
    amount: number
    currency: AiCurrency
    /** The digits shown at most: a single answer costs fractions of a cent */
    maximumFractionDigits?: number
    dataTestId?: string
}

/** What the AI cost in money, set apart from the tokens around it */
const CostChip: React.FC<CostChipProps> = ({ amount, currency, maximumFractionDigits = 4, dataTestId = "ai-cost" }) => {
    const { t, i18n } = useTranslation()
    const formatted = new Intl.NumberFormat(i18n.language, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits }).format(amount)

    return (
        <Badge variant="accent" data-testid={dataTestId}>
            {t("assistant.usage.cost", { formatted })}
        </Badge>
    )
}

export default CostChip
