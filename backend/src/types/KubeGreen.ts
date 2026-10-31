/**
 * What one day of the week looks like for an environment that sleeps on a kube-green schedule: awake from `wakeUpAt` to
 * `sleepAt`, or asleep all day. A SleepInfo has one set of days for both its times and wakes up only what it put to
 * sleep, so a sleep cannot span a midnight on a schedule that differs from day to day: every day is rendered on its
 * own, and a night spent asleep is woken at 23:59 and put back to sleep at 00:00.
 */
export interface KubeGreenDay {
    /** 0 (Sunday) to 6, as in cron */
    weekday: number
    /** Asleep all day when false: the times are then ignored */
    awake: boolean
    /** HH:MM, in timeZone; empty, awake from midnight */
    wakeUpAt?: string
    /** HH:MM, in timeZone; empty, awake until midnight */
    sleepAt?: string
}

/**
 * The schedule kube-green (https://kube-green.dev) puts an environment to sleep on: SleepInfos in its namespace scale
 * its Deployments to zero, suspend its CronJobs when asked, outside the hours each day is awake, and put them back.
 * The cluster needs the kube-green operator: without it the SleepInfos are committed and do nothing.
 */
export interface KubeGreenSettings {
    enabled: boolean
    /** One per day of the week, Sunday first */
    days: KubeGreenDay[]
    /** IANA time zone, e.g. Europe/Rome */
    timeZone: string
    suspendDeployments: boolean
    suspendStatefulSets: boolean
    suspendCronJobs: boolean
    /** The slugs of the applications that never sleep: each one's Deployment is named after it */
    excludeApplications?: string[]
}

export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]

/** Awake from 08:00 to 20:00 Monday to Friday, asleep at the weekend */
export const KUBE_GREEN_DEFAULT_DAYS = (): KubeGreenDay[] =>
    WEEKDAYS.map(weekday => (weekday >= 1 && weekday <= 5 ? { weekday, awake: true, wakeUpAt: "08:00", sleepAt: "20:00" } : { weekday, awake: false, wakeUpAt: "", sleepAt: "" }))

export const KUBE_GREEN_DEFAULTS: KubeGreenSettings = {
    enabled: false,
    days: KUBE_GREEN_DEFAULT_DAYS(),
    timeZone: "Europe/Rome",
    suspendDeployments: true,
    suspendStatefulSets: true,
    suspendCronJobs: false,
    excludeApplications: []
}

export const KUBE_GREEN_TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/** The last minute of a day: kube-green takes no 24:00, so a sleep until midnight wakes up a minute before */
export const KUBE_GREEN_END_OF_DAY = "23:59"

export const isTimeZone = (value: string): boolean => {
    try {
        new Intl.DateTimeFormat("en", { timeZone: value })
        return value !== ""
    } catch {
        return false
    }
}

/** A SleepInfo: asleep from `sleepAt` to `wakeUpAt` within each of `weekdays` */
export interface KubeGreenSleep {
    weekdays: number[]
    sleepAt: string
    wakeUpAt: string
}

/**
 * The sleeps a week of days makes, each within one day: before a day wakes up, after it goes to sleep, all day when it
 * does not wake up. Days asleep at the same times share one, so a week the same Monday to Friday takes a few.
 */
export const kubeGreenSleeps = (days: KubeGreenDay[]): KubeGreenSleep[] => {
    const sleeps = new Map<string, KubeGreenSleep>()
    const add = (weekday: number, sleepAt: string, wakeUpAt: string) => {
        if (sleepAt >= wakeUpAt) return
        const key = `${sleepAt}-${wakeUpAt}`
        const sleep = sleeps.get(key) ?? { weekdays: [], sleepAt, wakeUpAt }
        sleep.weekdays.push(weekday)
        sleeps.set(key, sleep)
    }
    for (const day of [...days].sort((a, b) => a.weekday - b.weekday)) {
        if (!day.awake) {
            add(day.weekday, "00:00", KUBE_GREEN_END_OF_DAY)
            continue
        }
        if (day.wakeUpAt) add(day.weekday, "00:00", day.wakeUpAt)
        if (day.sleepAt) add(day.weekday, day.sleepAt, KUBE_GREEN_END_OF_DAY)
    }
    return [...sleeps.values()].sort((a, b) => a.sleepAt.localeCompare(b.sleepAt) || a.wakeUpAt.localeCompare(b.wakeUpAt))
}

/** The days in cron notation, in the shortest form: ranges for consecutive days, `*` for all of them */
export const cronWeekdays = (weekdays: number[]): string => {
    const sorted = [...new Set(weekdays)].sort((a, b) => a - b)
    if (sorted.length === WEEKDAYS.length) return "*"
    const runs: number[][] = []
    for (const day of sorted) {
        const run = runs[runs.length - 1]
        if (run && day === run[run.length - 1] + 1) run.push(day)
        else runs.push([day])
    }
    return runs.map(run => (run.length > 1 ? `${run[0]}-${run[run.length - 1]}` : `${run[0]}`)).join(",")
}
