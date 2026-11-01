import { Card, CardContent, DescriptionItem, DescriptionList, Select, SelectContent, SelectControl, SelectItem, SelectTrigger, SelectValue } from "@flightroom/design-system"
import { Controller, useFormContext } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/atoms"
import LogLevelOption from "@/components/molecules/LogLevelOption"
import { type EnvironmentDTO, LOG_LEVELS, type LogLevel } from "@/hooks/apiClients/useEnvironmentsApi"

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

/** The level an environment hands its containers when it sets none, as the deploy does */
const DEFAULT_LOG_LEVEL: LogLevel = "info"

const LogLevelChip: React.FC<{ level: LogLevel }> = ({ level }) => (
    <Badge variant="outline">
        <LogLevelOption level={level} />
    </Badge>
)

/** The log level of a container above its logs, where it is looked for: its own in every environment, marked custom, else the one of each environment */
export const LogLevelCard: React.FC<{ value?: string | null; environments: EnvironmentDTO[] }> = ({ value, environments }) => {
    const { t } = useTranslation()

    return (
        <Card>
            <CardContent>
                <DescriptionList orientation="inline">
                    <DescriptionItem label={t("backends.log_level")}>
                        {isLogLevel(value) ? (
                            <span className="flex flex-wrap items-center gap-2">
                                <LogLevelChip level={value} />
                                <Badge variant="accent">{t("backends.log_level_custom")}</Badge>
                            </span>
                        ) : (
                            <ul className="flex flex-wrap items-center gap-x-4 gap-y-2">
                                {environments.map(environment => (
                                    <li key={environment._id} className="flex items-center gap-2 text-sm">
                                        <span className="font-medium">{environment.name}</span>
                                        <LogLevelChip level={environment.logLevel ?? DEFAULT_LOG_LEVEL} />
                                    </li>
                                ))}
                            </ul>
                        )}
                    </DescriptionItem>
                </DescriptionList>
            </CardContent>
        </Card>
    )
}

export default LogLevelOverrideField
