/**
 * The schedule kube-green (https://kube-green.dev) puts an environment to sleep on: a SleepInfo in its namespace scales
 * its Deployments to zero, suspends its CronJobs when asked, at `sleepAt` on `weekdays`, and puts them back at `wakeUpAt`.
 * The cluster needs the kube-green operator: without it the SleepInfo is committed and does nothing.
 */
export interface KubeGreenSettings {
    enabled: boolean
    /** The days of the week, in cron notation: `1-5` from Monday to Friday, `*` every day */
    weekdays: string
    /** HH:MM, in timeZone */
    sleepAt: string
    /** HH:MM, in timeZone; empty, the environment sleeps until it is deployed again */
    wakeUpAt?: string
    /** IANA time zone, e.g. Europe/Rome */
    timeZone: string
    suspendDeployments: boolean
    suspendStatefulSets: boolean
    suspendCronJobs: boolean
    /** The slugs of the applications that never sleep: each one's Deployment is named after it */
    excludeApplications?: string[]
}

export const KUBE_GREEN_DEFAULTS: KubeGreenSettings = {
    enabled: false,
    weekdays: "1-5",
    sleepAt: "20:00",
    wakeUpAt: "08:00",
    timeZone: "Europe/Rome",
    suspendDeployments: true,
    suspendStatefulSets: true,
    suspendCronJobs: false,
    excludeApplications: []
}

/** A day 0 (Sunday) to 6, or a range of them, separated by commas; `*` for every day */
export const KUBE_GREEN_WEEKDAYS = /^(\*|[0-6](-[0-6])?(,[0-6](-[0-6])?)*)$/

export const KUBE_GREEN_TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export const isTimeZone = (value: string): boolean => {
    try {
        new Intl.DateTimeFormat("en", { timeZone: value })
        return value !== ""
    } catch {
        return false
    }
}
