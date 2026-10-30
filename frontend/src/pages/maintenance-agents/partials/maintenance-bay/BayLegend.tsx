import { StatusDot } from "@flightroom/design-system"
import { useTranslation } from "react-i18next"
import { DroneGlyph, ShuttleGlyph, STATUS_DOT_CLASS } from "../MaintenanceBadges"

/** What the drones, the shuttles, the lights, the beams and the canisters mean */
export const BayLegend: React.FC<{ compact: boolean }> = ({ compact }) => {
    const { t } = useTranslation()
    return (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border bg-card px-3 py-2 text-xs font-medium text-card-foreground shadow-sm">
            <span className="flex items-center gap-1.5">
                <DroneGlyph />
                {t("maintenance.bay.legend_container")}
            </span>
            <span className="flex items-center gap-1.5">
                <ShuttleGlyph />
                {t("maintenance.bay.legend_job")}
            </span>
            {(["scheduled", "standby", "failed", "recent"] as const).map(status => (
                <span key={status} className="flex items-center gap-1.5">
                    <StatusDot size="lg" className={STATUS_DOT_CLASS[status]} />
                    {t(`maintenance.bay.legend_${status}`)}
                </span>
            ))}
            {!compact && (
                <span className="flex items-center gap-1.5">
                    <svg viewBox="0 0 18 4" className="h-1 w-4.5" aria-hidden="true">
                        <path d="M0 2H18" className="stroke-zomp-600 dark:stroke-zomp-400" strokeWidth="2" strokeDasharray="3 3" />
                    </svg>
                    {t("maintenance.bay.legend_beam")}
                </span>
            )}
            <span className="flex items-center gap-1.5">
                <span className="h-3.5 w-2 rounded-[3px] bg-zomp-700 dark:bg-zomp-200" aria-hidden="true" />
                {t("maintenance.bay.legend_canister")}
            </span>
        </div>
    )
}
