import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, NavItem } from "@flightroom/design-system"
import { Globe } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import useUserApi from "@/hooks/apiClients/useUserApi"
import useThemeStore from "@/store/useThemeStore"
import useUserStore from "@/store/useUserStore"
import { setLanguageInLocalStorage } from "@/utils/localStorageUtils"

interface LanguageSelectorProps {
    isSidebarCollapsed?: boolean
    purpose?: "sidebar" | "page"
    dropdownContentSide?: "top" | "right" | "bottom" | "left"
    dropdownContentAlign?: "start" | "center" | "end"
}

/** Changes the language of the console, and saves it on the user when one is logged in */
export const useChangeLanguage = () => {
    const { i18n } = useTranslation()
    const userApi = useUserApi()
    const userStore = useUserStore()
    const themeStore = useThemeStore()

    return (lng: string) => {
        i18n.changeLanguage(lng)
        setLanguageInLocalStorage(lng)
        if (userStore.user) {
            userApi.saveLanguage(lng)
            themeStore.setLanguage(lng)
        }
    }
}

const LanguageSelector: React.FC<LanguageSelectorProps> = ({ isSidebarCollapsed, purpose = "sidebar", dropdownContentSide, dropdownContentAlign }: LanguageSelectorProps) => {
    const { t } = useTranslation()
    const changeLanguage = useChangeLanguage()

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                {purpose === "page" ? (
                    <Button variant="ghost" size="icon" aria-label="Language selector">
                        {<Globe />}
                    </Button>
                ) : (
                    <NavItem type="secondary" icon={<Globe />} name={t("language.change")} aria-label="Language selector" isSidebarCollapsed={isSidebarCollapsed} />
                )}
            </DropdownMenuTrigger>
            <DropdownMenuContent side={dropdownContentSide || purpose === "page" ? "bottom" : "right"} align={dropdownContentAlign || purpose === "page" ? "end" : "start"}>
                <DropdownMenuItem onClick={() => changeLanguage("en")}>{t("language.english")}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => changeLanguage("it")}>{t("language.italian")}</DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    )
}

export default LanguageSelector
