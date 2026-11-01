import { Card, CardContent, DescriptionItem, DescriptionList, Select, SelectContent, SelectControl, SelectItem, SelectTrigger, SelectValue } from "@flightroom/design-system"
import { Controller, useFormContext } from "react-hook-form"
import { useTranslation } from "react-i18next"
import LogLevelOption from "@/components/molecules/LogLevelOption"
import { LOG_LEVELS, type LogLevel } from "@/hooks/apiClients/useEnvironmentsApi"

/** The Select takes no empty value: what stands for the level of each environment, empty in the form */
const INHERITED = "environment"

const isLogLevel = (value: unknown): value is LogLevel => typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value)

/** What the API receives for the log level of the form: null for the level of each environment */
export const logLevelOf = (value?: string): LogLevel | null => (isLogLevel(value) ? value : null)

/** LOG_LEVEL of the container in every environment, to look into it alone: left on the environment's, each environment gives its own */
export const LogLevelOverrideField: React.FC = () => {
    const { t } = useTranslation()
    const { control } = useFormContext()

    return (
        <Controller
            control={control}
            name="logLevel"
            render={({ field }) => (
                <SelectControl label={t("backends.log_level")} description={t("backends.log_level_hint")}>
                    <Select value={isLogLevel(field.value) ? field.value : INHERITED} onValueChange={value => field.onChange(value === INHERITED ? "" : value)}>
                        <SelectTrigger dataTestId="container-log-level">
                            <SelectValue>{isLogLevel(field.value) ? <LogLevelOption level={field.value} /> : t("backends.log_level_inherited")}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={INHERITED}>{t("backends.log_level_inherited")}</SelectItem>
                            {LOG_LEVELS.map(level => (
                                <SelectItem key={level} value={level}>
                                    <LogLevelOption level={level} />
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </SelectControl>
            )}
        />
    )
}

/** The log level of a container as the detail views show it: the environment's when it sets none */
export const LogLevelValue: React.FC<{ value?: string | null }> = ({ value }) => {
    const { t } = useTranslation()

    return isLogLevel(value) ? <LogLevelOption level={value} /> : <span className="text-foreground-secondary">{t("backends.log_level_inherited")}</span>
}

/** The log level of a container above its logs, where it is looked for */
export const LogLevelCard: React.FC<{ value?: string | null }> = ({ value }) => {
    const { t } = useTranslation()

    return (
        <Card>
            <CardContent>
                <DescriptionList orientation="inline">
                    <DescriptionItem label={t("backends.log_level")}>
                        <LogLevelValue value={value} />
                    </DescriptionItem>
                </DescriptionList>
            </CardContent>
        </Card>
    )
}

export default LogLevelOverrideField
