import { useTranslation } from "react-i18next"
import type { LogLevel } from "@/hooks/apiClients/useEnvironmentsApi"
import { cn } from "@/utils/styleUtils"

/** I colori dei livelli, come nelle righe dei log: grigio per trace e debug, blu per info, ambra per warn, rosso per error e fatal */
export const LOG_LEVEL_COLORS: Record<LogLevel, { dot: string; text: string }> = {
    trace: { dot: "bg-muted-foreground/50", text: "text-foreground-secondary" },
    debug: { dot: "bg-muted-foreground", text: "text-foreground-secondary" },
    info: { dot: "bg-info", text: "text-info" },
    warn: { dot: "bg-warning", text: "text-warning" },
    error: { dot: "bg-destructive", text: "text-destructive" },
    fatal: { dot: "bg-destructive-active", text: "font-semibold text-destructive-active" }
}

/** Un livello di log col suo colore: nelle select del livello di un ambiente e di un container */
export function LogLevelOption({ level }: { level: LogLevel }) {
    const { t } = useTranslation()
    return (
        <span className={cn("flex items-center gap-2", LOG_LEVEL_COLORS[level].text)}>
            <span className={cn("size-2.5 shrink-0 rounded-full", LOG_LEVEL_COLORS[level].dot)} aria-hidden="true" />
            {t(`environment.form.log_levels.${level}`)}
        </span>
    )
}

export default LogLevelOption
