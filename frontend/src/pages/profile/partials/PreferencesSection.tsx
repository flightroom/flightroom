import { Card, CardContent, CardDescription, CardHeader, CardTitle, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@flightroom/design-system"
import { Monitor, Moon, Sun } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useChangeLanguage } from "@/components/ui/Sidebar/partials/LanguageSelector"
import { useChangeTheme } from "@/components/ui/Sidebar/partials/ThemeToggle"
import useThemeStore, { ThemeEnum } from "@/store/useThemeStore"

const THEMES = [
    { value: ThemeEnum.LIGHT, icon: Sun, label: "theme.light" },
    { value: ThemeEnum.DARK, icon: Moon, label: "theme.dark" },
    { value: ThemeEnum.SYSTEM, icon: Monitor, label: "theme.system" }
] as const

/** Language and theme of the console: each choice is saved as soon as it is made, as the selectors of the login pages do */
export const PreferencesSection: React.FC = () => {
    const { t, i18n } = useTranslation()
    const { theme } = useThemeStore()
    const changeLanguage = useChangeLanguage()
    const changeTheme = useChangeTheme()
    const language = i18n.resolvedLanguage?.startsWith("it") ? "it" : "en"

    return (
        <Card className="pt-4">
            <CardHeader>
                <CardTitle as="h2">{t("profile.preferences.title")}</CardTitle>
                <CardDescription>{t("profile.preferences.subtitle")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-4 pt-4">
                <div className="flex flex-[1_1_200px] flex-col gap-1">
                    <span className="text-sm font-medium">{t("profile.preferences.language")}</span>
                    <Select value={language} onValueChange={changeLanguage}>
                        <SelectTrigger aria-label={t("profile.preferences.language")} dataTestId="profile-language">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="it">{t("language.italian")}</SelectItem>
                            <SelectItem value="en">{t("language.english")}</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <div className="flex flex-[1_1_200px] flex-col gap-1">
                    <span className="text-sm font-medium">{t("profile.preferences.theme")}</span>
                    <Select value={theme} onValueChange={value => changeTheme(value as ThemeEnum)}>
                        <SelectTrigger aria-label={t("profile.preferences.theme")} dataTestId="profile-theme">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {THEMES.map(({ value, icon: Icon, label }) => (
                                <SelectItem key={value} value={value}>
                                    <span className="flex items-center gap-2">
                                        <Icon className="h-4 w-4" aria-hidden="true" />
                                        {t(label)}
                                    </span>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </CardContent>
        </Card>
    )
}

export default PreferencesSection
