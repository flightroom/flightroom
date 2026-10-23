import { describe, expect, it } from "vitest"
import { canonicalTimeZone, isValidSchedule } from "./MaintenanceAgent"

describe("isValidSchedule", () => {
    it.each(["0 3 * * *", "*/15 * * * *", "0 9-18/2 * * mon-fri", "30 2 1,15 * *", "0 0 * jan,jul sun", "@daily", "@HOURLY", " 5 4 * * 6 "])(
        "given %s, when it is checked, then a CronJob takes it",
        schedule => {
            expect(isValidSchedule(schedule)).toBe(true)
        }
    )

    it.each(["", "* * * *", "* * * * * *", "60 * * * *", "0 24 * * *", "0 0 0 * *", "0 0 * 13 *", "0 0 * * 7", "*/0 * * * *", "5-1 * * * *", "@reboot", "a b c d e"])(
        "given %s, when it is checked, then it is refused",
        schedule => {
            expect(isValidSchedule(schedule)).toBe(false)
        }
    )
})

describe("canonicalTimeZone", () => {
    it.each([
        ["Europe/Rome", "Europe/Rome"],
        ["europe/rome", "Europe/Rome"],
        ["UTC", "UTC"]
    ])("given %s, when it is checked, then the cluster reads it as %s", (timeZone, expected) => {
        expect(canonicalTimeZone(timeZone)).toBe(expected)
    })

    it.each(["Mars/Olympus", "+01:00", "Europe/Rome; rm", ""])("given %s, when it is checked, then it is refused", timeZone => {
        expect(canonicalTimeZone(timeZone)).toBeUndefined()
    })
})
