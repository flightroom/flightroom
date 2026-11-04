import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@flightroom/design-system"
import { CalendarRange } from "lucide-react"
import { useTranslation } from "react-i18next"
import { AI_USAGE_PERIODS, AiUsagePeriod } from "@/hooks/apiClients/useAiUsageApi"

interface AiUsagePeriodSelectProps {
    value: AiUsagePeriod
    onChange: (period: AiUsagePeriod) => void
    dataTestId: string
}

/** The period a usage card sums over, in its header. */
const AiUsagePeriodSelect: React.FC<AiUsagePeriodSelectProps> = ({ value, onChange, dataTestId }) => {
    const { t } = useTranslation()
    return (
        <Select layoutSize="sm" value={value} onValueChange={period => onChange(period as AiUsagePeriod)}>
            <SelectTrigger aria-label={t("ai_usage.period.label")} className="w-auto shrink-0" dataTestId={dataTestId}>
                <CalendarRange aria-hidden="true" />
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {AI_USAGE_PERIODS.map(period => (
                    <SelectItem key={period} value={period}>
                        {t(`ai_usage.period.${period}`)}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    )
}

export default AiUsagePeriodSelect
