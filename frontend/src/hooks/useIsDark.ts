import { useEffect, useState } from "react"
import useThemeStore, { ThemeEnum } from "@/store/useThemeStore"

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)"

/** The theme the app is shown in, resolving the system one and following it when it changes. */
const useIsDark = () => {
    const theme = useThemeStore(state => state.theme)
    const [systemDark, setSystemDark] = useState(() => window.matchMedia(DARK_SCHEME_QUERY).matches)
    useEffect(() => {
        const query = window.matchMedia(DARK_SCHEME_QUERY)
        const onChange = () => setSystemDark(query.matches)
        query.addEventListener("change", onChange)
        return () => query.removeEventListener("change", onChange)
    }, [])
    return theme === ThemeEnum.DARK || (theme === ThemeEnum.SYSTEM && systemDark)
}

export default useIsDark
