import { type SimpleIcon, siDotnet, siGo, siNodedotjs, siOpenjdk, siPython } from "simple-icons"
import type { SandboxLanguage } from "@/hooks/apiClients/useInstallationApi"
import { cn } from "@/utils/styleUtils"
import { isNearBlack } from "./technologyIcons"

/** Java non e' una tecnologia della console (lo sono Spring Boot, Quarkus e Micronaut): il suo logo e' OpenJDK */
const LANGUAGE_ICONS: Record<SandboxLanguage, SimpleIcon> = {
    node: siNodedotjs,
    java: siOpenjdk,
    python: siPython,
    go: siGo,
    dotnet: siDotnet
}

/** Il logo di un linguaggio nel colore del marchio, sempre accanto al suo nome: nascosto agli screen reader */
export const LanguageLogo: React.FC<{ language: SandboxLanguage; size?: number; className?: string }> = ({ language, size = 14, className }) => {
    const icon = LANGUAGE_ICONS[language]
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={cn("shrink-0", className)} focusable="false" aria-hidden="true" data-language={language}>
            <path d={icon.path} fill={isNearBlack(icon.hex) ? "currentColor" : `#${icon.hex}`} />
        </svg>
    )
}

export default LanguageLogo
