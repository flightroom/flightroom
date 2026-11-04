import { Card, CardContent, CardDescription, CardHeader, CardTitle, SelectField } from "@flightroom/design-system"
import type { TFunction } from "i18next"
import { useWatch } from "react-hook-form"
import { useTranslation } from "react-i18next"
import * as z from "zod"
import TextField from "@/components/input/TextField.rhf"
import type { Backend } from "@/hooks/apiClients/useBackendsApi"
import { describeCron, isValidCron, normalizeCron, SCHEDULE_PRESETS, scheduleModeOf } from "@/pages/maintenance-agents/partials/maintenance"

/** Always on as a Deployment, one of the presets, or any cron: the last four run it as a CronJob */
export type BackendScheduleMode = "always" | keyof typeof SCHEDULE_PRESETS | "custom"

const MODES: BackendScheduleMode[] = ["always", "hourly", "daily", "weekly", "custom"]

export const backendScheduleShape = {
    scheduleMode: z.enum(["always", "hourly", "daily", "weekly", "custom"]),
    schedule: z.string(),
    timeZone: z.string()
}

/** The time zone of the browser: the hours a person picks are theirs, not the cluster's */
const browserTimeZone = () => {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""
    } catch {
        return ""
    }
}

export const scheduleFormValues = (backend?: Pick<Backend, "schedule" | "timeZone">) => {
    const mode = scheduleModeOf(backend?.schedule)
    return {
        scheduleMode: (mode === "manual" ? "always" : mode) as BackendScheduleMode,
        schedule: backend?.schedule ?? "",
        // One already on a schedule keeps its zone, the cluster's included (none); a new one takes the browser's
        timeZone: backend?.schedule ? (backend.timeZone ?? "") : browserTimeZone()
    }
}

export const refineSchedule = (data: { scheduleMode: BackendScheduleMode; schedule: string }, ctx: z.RefinementCtx, message: string) => {
    if (data.scheduleMode === "custom" && !isValidCron(data.schedule)) ctx.addIssue({ code: "custom", message, path: ["schedule"] })
}

/** What the API takes: no schedule when always on, else the cron of the preset or the one typed */
export const scheduleToSubmit = (data: { scheduleMode: BackendScheduleMode; schedule: string; timeZone: string }) => {
    if (data.scheduleMode === "always") return { schedule: null, timeZone: null }
    const schedule = data.scheduleMode === "custom" ? normalizeCron(data.schedule) : SCHEDULE_PRESETS[data.scheduleMode]
    return { schedule, timeZone: data.timeZone || null }
}

const capitalized = (text: string | undefined) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : "")

/** A schedule said in words, "Every day at 03:00", or the cron as it is */
export const scheduleLabel = (schedule: string, t: TFunction, language: string) => capitalized(describeCron(schedule, t, language)) || schedule

/** Whether the backend is always on or runs on a schedule: one choice, and a cron only when none of the presets fits */
export const BackendScheduleCard: React.FC = () => {
    const { t, i18n } = useTranslation()
    const [mode, schedule, timeZone] = useWatch({ name: ["scheduleMode", "schedule", "timeZone"] }) as [BackendScheduleMode, string, string]
    const scheduled = mode !== "always"
    const preview = mode === "custom" && isValidCron(schedule ?? "") ? describeCron(schedule, t, i18n.language) : undefined

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("backends.schedule.title")}</CardTitle>
                <CardDescription>{t("backends.schedule.description")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 pt-3">
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                    <SelectField
                        name="scheduleMode"
                        label={t("backends.schedule.label")}
                        options={MODES.map(option => ({
                            value: option,
                            label: option === "always" ? t("backends.schedule.always") : option === "custom" ? t("backends.schedule.custom") : scheduleLabel(SCHEDULE_PRESETS[option], t, i18n.language)
                        }))}
                        description={scheduled ? (timeZone ? t("backends.schedule.scheduled_hint", { timeZone }) : t("backends.schedule.scheduled_hint_cluster")) : t("backends.schedule.always_hint")}
                        className="w-full"
                        containerClassName="flex-[1_1_240px]"
                    />
                    {mode === "custom" && (
                        <TextField
                            name="schedule"
                            label={t("maintenance.schedule.cron")}
                            placeholder="*/15 * * * *"
                            description={preview ? t("maintenance.schedule.custom_preview", { description: preview }) : t("maintenance.schedule.cron_hint")}
                            className="font-mono"
                            autoComplete="off"
                            required
                            containerClassName="flex-[1_1_240px]"
                        />
                    )}
                </div>
            </CardContent>
        </Card>
    )
}

export default BackendScheduleCard
