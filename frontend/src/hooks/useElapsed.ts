import { useEffect, useState } from "react"

export const formatElapsed = (totalSeconds: number) => {
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0")
    const seconds = String(totalSeconds % 60).padStart(2, "0")
    return hours > 0 ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`
}

/** Time since `startedAt`, ticking every second until `endedAt` is known */
const useElapsed = (startedAt: number, endedAt?: number) => {
    const [now, setNow] = useState(Date.now)
    useEffect(() => {
        if (endedAt) return
        const interval = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(interval)
    }, [endedAt])
    return formatElapsed(Math.max(0, Math.floor(((endedAt ?? now) - startedAt) / 1000)))
}

export default useElapsed
