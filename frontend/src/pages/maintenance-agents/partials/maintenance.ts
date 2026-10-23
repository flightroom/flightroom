import { useQuery } from "@tanstack/react-query"
import type { TFunction } from "i18next"
import { useEffect, useState } from "react"
import useMaintenanceAgentsApi, { MaintenanceAgent } from "@/hooks/apiClients/useMaintenanceAgentsApi"
import useProjectStore from "@/store/useProjectStore"

export const MAINTENANCE_LIST_PATH = "/maintenance-agents"
/** Singular, as for the services: the sidebar lights its item on /maintenance-agent/... too */
export const maintenanceAgentPath = (id: string) => `/maintenance-agent/${id}`

/** Same rule as the slug of a service: it names the workspace folder and the image */
export const MAINTENANCE_SLUG = /^[a-z0-9][a-z0-9-]{1,49}$/

/** The macros the backend accepts besides the five fields */
const CRON_MACRO = /^@(hourly|daily|weekly|monthly|yearly|annually|midnight)$/i
/** A light check of one field: numbers, names, steps, ranges and lists; the backend has the last word */
const CRON_FIELD = /^[\dA-Za-z*/,?-]+$/

export const normalizeCron = (expression: string) => expression.trim().replace(/\s+/g, " ")

export const isValidCron = (expression: string) => {
    const cron = normalizeCron(expression)
    if (CRON_MACRO.test(cron)) return true
    const fields = cron.split(" ")
    return fields.length === 5 && fields.every(field => CRON_FIELD.test(field))
}

/** An IANA time zone the browser knows: the same database the cluster reads it from */
export const isValidTimeZone = (timeZone: string) => {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone })
        return true
    } catch {
        return false
    }
}

/** The schedules a form offers with one click, the custom one being any cron */
export const SCHEDULE_PRESETS = {
    hourly: "0 * * * *",
    daily: "0 3 * * *",
    weekly: "0 3 * * 1"
} as const

export type ScheduleMode = "manual" | keyof typeof SCHEDULE_PRESETS | "custom"

export const scheduleModeOf = (schedule?: string | null): ScheduleMode => {
    if (!schedule?.trim()) return "manual"
    const cron = normalizeCron(schedule)
    const preset = (Object.keys(SCHEDULE_PRESETS) as (keyof typeof SCHEDULE_PRESETS)[]).find(key => SCHEDULE_PRESETS[key] === cron)
    return preset ?? "custom"
}

const NUMBER = /^\d+$/
const STEP = /^\*\/(\d+)$/
/** 7 January 2024 was a Sunday: day 0 of cron */
const SUNDAY = Date.UTC(2024, 0, 7, 12)

const weekdayName = (day: number, language: string, width: "long" | "short") => new Intl.DateTimeFormat(language, { weekday: width, timeZone: "UTC" }).format(new Date(SUNDAY + (day % 7) * 86_400_000))

const timeOf = (minute: string, hour: string) => `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`

/**
 * A cron said in words, long ("every day at 03:00") or short for the clock plate of a bay ("daily 03:00"),
 * for the common patterns and the presets; undefined for the others, which are shown as they are.
 */
export const describeCron = (expression: string | null | undefined, t: TFunction, language: string, short = false): string | undefined => {
    if (!expression?.trim()) return undefined
    const prefix = short ? "maintenance.schedule.short" : "maintenance.schedule.describe"
    const cron = normalizeCron(expression)
    const macro: Record<string, string> = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *" }
    const fields = (macro[cron] ?? cron).split(" ")
    if (fields.length !== 5) return undefined
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
    if (month !== "*") return undefined

    const everyDay = dayOfMonth === "*" && dayOfWeek === "*"
    if (everyDay && hour === "*") {
        if (minute === "*") return t(`${prefix}.every_minute`)
        const step = STEP.exec(minute)
        if (step) return t(`${prefix}.every_n_minutes`, { count: Number(step[1]) })
        if (minute === "0") return t(`${prefix}.hourly`)
        if (NUMBER.test(minute)) return t(`${prefix}.hourly_at`, { minute: minute.padStart(2, "0") })
        return undefined
    }
    if (!NUMBER.test(minute)) return undefined
    const hourStep = STEP.exec(hour)
    if (everyDay && hourStep) return t(`${prefix}.every_n_hours`, { count: Number(hourStep[1]) })
    if (!NUMBER.test(hour)) return undefined

    const time = timeOf(minute, hour)
    if (everyDay) return t(`${prefix}.daily`, { time })
    if (dayOfMonth === "*" && dayOfWeek === "1-5") return t(`${prefix}.weekdays`, { time })
    if (dayOfMonth === "*" && NUMBER.test(dayOfWeek)) return t(`${prefix}.weekly`, { time, day: weekdayName(Number(dayOfWeek), language, short ? "short" : "long") })
    if (dayOfWeek === "*" && NUMBER.test(dayOfMonth)) return t(`${prefix}.monthly`, { time, day: Number(dayOfMonth) })
    return undefined
}

/**
 * What the status light of an agent says: its last run failed, it ran in the last minutes, it runs on a
 * schedule or it waits for someone to start it. A failure wins over the rest.
 */
export type MaintenanceStatus = "failed" | "recent" | "scheduled" | "standby"

/** How long a run counts as just done */
export const RECENT_RUN_MS = 5 * 60 * 1000

export const maintenanceStatusOf = (agent: Pick<MaintenanceAgent, "lastRun" | "schedule">, now: number): MaintenanceStatus => {
    if (agent.lastRun && !agent.lastRun.ok) return "failed"
    if (agent.lastRun && now - new Date(agent.lastRun.at).getTime() < RECENT_RUN_MS) return "recent"
    return agent.schedule?.trim() ? "scheduled" : "standby"
}

/** The time, ticking every `intervalMs`: enough for a run to stop counting as recent while the page is open */
export const useNow = (intervalMs = 30_000) => {
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
        return () => window.clearInterval(timer)
    }, [intervalMs])
    return now
}

/** The maintenance agents of the current project */
export const useMaintenanceAgentsQuery = () => {
    const projectId = useProjectStore(state => state.project?._id)
    const api = useMaintenanceAgentsApi()
    return useQuery({ queryKey: ["maintenance-agents", projectId], queryFn: api.getAll, enabled: !!projectId })
}
