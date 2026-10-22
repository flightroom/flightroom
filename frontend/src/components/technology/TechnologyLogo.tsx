import { useTranslation } from "react-i18next"
import { cn } from "@/utils/styleUtils"
import { TECHNOLOGY_LABEL_KEYS, type Technology } from "@/utils/technologies"
import { isNearBlack, TECHNOLOGY_ICONS, technologyMonogram } from "./technologyIcons"

interface TechnologyLogoProps {
    /** Senza tecnologia non si disegna niente */
    technology?: Technology
    /** Lato in pixel */
    size?: number
    className?: string
    /** Il nome accessibile: di default il nome della tecnologia */
    title?: string
    /** Accanto a un testo che gia' nomina la tecnologia: nascosto agli screen reader */
    decorative?: boolean
}

/** Il logo di una tecnologia nel colore del marchio, disegnato inline dal path di simple-icons */
export const TechnologyLogo: React.FC<TechnologyLogoProps> = ({ technology, size = 16, className, title, decorative }) => {
    const { t } = useTranslation()
    if (!technology) return null
    const icon = TECHNOLOGY_ICONS[technology]
    const label = title ?? t(TECHNOLOGY_LABEL_KEYS[technology])
    const a11y = decorative ? { "aria-hidden": true } : { role: "img", "aria-label": label }

    return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={cn("shrink-0", className)} focusable="false" data-technology={technology} {...a11y}>
            {!decorative && <title>{label}</title>}
            {icon ? (
                <path d={icon.path} fill={isNearBlack(icon.hex) ? "currentColor" : `#${icon.hex}`} />
            ) : (
                <>
                    <circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" strokeWidth="2" />
                    <text x="12" y="16.5" textAnchor="middle" fontSize="12" fontWeight="700" fill="currentColor">
                        {technologyMonogram(technology)}
                    </text>
                </>
            )}
        </svg>
    )
}

export default TechnologyLogo
