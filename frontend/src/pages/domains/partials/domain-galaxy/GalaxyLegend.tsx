import { useTranslation } from "react-i18next"

interface GalaxyLegendProps {
    isBackend: boolean
    moons: boolean
    relations: boolean
    stations: boolean
    ships: boolean
}

/** A station as the legend shows it: the shape paintStation draws on the canvas. */
const StationGlyph: React.FC = () => (
    <svg viewBox="-12 -6 24 12" className="h-2.5 w-5 text-foreground" aria-hidden="true">
        <rect x="-12" y="-3.5" width="7" height="7" rx="0.5" fill="currentColor" opacity="0.55" />
        <rect x="5" y="-3.5" width="7" height="7" rx="0.5" fill="currentColor" opacity="0.55" />
        <path d="M-5 0 H5" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="0" cy="0" r="5" fill="currentColor" />
        <circle cx="0" cy="0" r="2.4" className="fill-zomp-400 dark:fill-zomp-200" />
    </svg>
)

/** The rocket of the ships, as the legend shows it: the shape drawRocket paints on the canvas. */
const ShipGlyph: React.FC = () => (
    <svg viewBox="-20 -16 40 32" className="h-2.5 w-3.5 -rotate-45 text-foreground" aria-hidden="true">
        <path d="M-14 -6 L-19 0 L-14 6 Z" className="fill-sunglow-600 dark:fill-sunglow-200" />
        <path d="M-10 -7 L-18 -15 L-4 -7 Z M-10 7 L-18 15 L-4 7 Z" fill="currentColor" />
        <ellipse cx="0" cy="0" rx="18" ry="9" fill="currentColor" />
        <circle cx="6" cy="0" r="4" className="fill-card" />
    </svg>
)

/** What the marks of the map mean, only the ones it can show. */
const GalaxyLegend: React.FC<GalaxyLegendProps> = ({ isBackend, moons, relations, stations, ships }) => {
    const { t } = useTranslation()
    return (
        <div className="pointer-events-none absolute top-3 left-3 flex flex-wrap items-center gap-4 rounded-md border border-border bg-card px-3 py-2 text-xs font-medium shadow-sm">
            {!isBackend && (
                <span className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-full bg-primary" aria-hidden="true" />
                    {t("domains.detail.frontend_title")}
                </span>
            )}
            <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-full bg-zomp-600 dark:bg-zomp-400" aria-hidden="true" />
                {t("domains.detail.backend_title")}
            </span>
            {moons && (
                <span className="flex items-center gap-1.5">
                    {/* A moon on its orbit, as on the map */}
                    <span className="relative size-3.5 rounded-full border border-foreground/30" aria-hidden="true">
                        <span className="absolute -top-[3px] left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-zomp-700 dark:bg-zomp-200" />
                    </span>
                    {t("domains.galaxy.legend_moon")}
                </span>
            )}
            {!isBackend && (
                <>
                    <span className="flex items-center gap-1.5">
                        <span className="size-3 rounded-full border-2 border-sunglow-600 dark:border-sunglow-200" aria-hidden="true" />
                        {t("domains.galaxy.legend_canary")}
                    </span>
                    <span className="flex items-center gap-1.5">
                        <span className="h-0.5 w-4 rounded-full bg-olivine-600 dark:bg-olivine-300" aria-hidden="true" />
                        {t("domains.galaxy.legend_bridge")}
                    </span>
                </>
            )}
            {relations && (
                <span className="flex items-center gap-1.5">
                    <span className="h-1 w-4 rounded-full bg-foreground/60" aria-hidden="true" />
                    {t("domains.galaxy.legend_relation")}
                </span>
            )}
            {stations && (
                <span className="flex items-center gap-1.5">
                    <StationGlyph />
                    {t("domains.galaxy.legend_station")}
                </span>
            )}
            {ships && (
                <span className="flex items-center gap-1.5">
                    <ShipGlyph />
                    {t("domains.galaxy.legend_agent")}
                </span>
            )}
        </div>
    )
}

export default GalaxyLegend
