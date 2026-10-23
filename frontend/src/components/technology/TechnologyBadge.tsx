import { useTranslation } from "react-i18next"
import { Badge } from "@/components/atoms"
import { cn } from "@/utils/styleUtils"
import { TECHNOLOGY_LABEL_KEYS, type Technology } from "@/utils/technologies"
import TechnologyLogo from "./TechnologyLogo"

interface TechnologyBadgeProps {
    technology: Technology
    /** Il testo accanto al logo: di default il nome della tecnologia */
    children?: React.ReactNode
    className?: string
    title?: string
}

/** Logo e nome della tecnologia, dove c'e' spazio per entrambi */
export const TechnologyBadge: React.FC<TechnologyBadgeProps> = ({ technology, children, className, title }) => {
    const { t } = useTranslation()

    return (
        <Badge variant="outline" className={cn("gap-1", className)} title={title}>
            <TechnologyLogo technology={technology} size={12} decorative />
            {children ?? t(TECHNOLOGY_LABEL_KEYS[technology])}
        </Badge>
    )
}

export default TechnologyBadge
