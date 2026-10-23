import { useTranslation } from "react-i18next"
import { isNearBlack } from "@/components/technology/technologyIcons"
import { optionLabel, typeLabel, variantLabel } from "@/pages/resources/partials/resources"
import { cn } from "@/utils/styleUtils"
import { type ResourceIconSource, resourceBrand, resourceEngine, resourceTypeIcon } from "./resourceIcons"

interface ResourceIconProps {
    /** Una Resource, o solo tipo, variante ed eventualmente motore */
    resource: ResourceIconSource
    /** Lato in pixel */
    size?: number
    className?: string
    /** Il nome accessibile: di default il tipo, con il motore o la variante */
    title?: string
    /** Accanto a un testo che gia' nomina il tipo e il fornitore: nascosta agli screen reader */
    decorative?: boolean
}

/**
 * L'icona di una risorsa: il marchio del fornitore o del motore concreto quando simple-icons lo ha (nel
 * colore del marchio, disegnato inline dal suo path), altrimenti l'icona lucide del tipo.
 */
export const ResourceIcon: React.FC<ResourceIconProps> = ({ resource, size = 16, className, title, decorative }) => {
    const { t } = useTranslation()
    const brand = resourceBrand(resource)
    const engine = resource.type === "database" ? resourceEngine(resource) : undefined
    const detail = engine ? optionLabel(t, "engine", engine) : resource.variant ? variantLabel(t, resource.type, resource.variant) : undefined
    const label = title ?? (detail ? `${typeLabel(t, resource.type)} (${detail})` : typeLabel(t, resource.type))
    const a11y = decorative ? { "aria-hidden": true } : { role: "img", "aria-label": label }
    const classes = cn("shrink-0", className)

    if (!brand) {
        const Icon = resourceTypeIcon(resource.type)
        return (
            <Icon size={size} className={classes} focusable="false" data-resource-type={resource.type} {...a11y}>
                {!decorative && <title>{label}</title>}
            </Icon>
        )
    }

    return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={classes} focusable="false" data-resource-type={resource.type} {...a11y}>
            {!decorative && <title>{label}</title>}
            <path d={brand.path} fill={isNearBlack(brand.hex) ? "currentColor" : `#${brand.hex}`} />
        </svg>
    )
}

export default ResourceIcon
