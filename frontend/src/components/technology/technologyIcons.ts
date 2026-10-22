import { type SimpleIcon, siAngular, siDotnet, siGo, siNodedotjs, siPython, siQuarkus, siReact, siSpringboot, siVuedotjs } from "simple-icons"
import type { Technology } from "@/utils/technologies"

/** Solo le icone usate, cosi' il bundle non si porta dietro tutto simple-icons. Micronaut non c'e': si disegna un monogramma */
export const TECHNOLOGY_ICONS: Record<Technology, SimpleIcon | undefined> = {
    REACT: siReact,
    VUE: siVuedotjs,
    ANGULAR: siAngular,
    NODE: siNodedotjs,
    PYTHON: siPython,
    SPRING_BOOT: siSpringboot,
    QUARKUS: siQuarkus,
    MICRONAUT: undefined,
    GO: siGo,
    DOTNET: siDotnet
}

/** Lettera del monogramma per le tecnologie senza icona */
export const technologyMonogram = (technology: Technology) => technology.charAt(0)

/** Un marchio quasi nero sparirebbe sul tema scuro: in quel caso il logo prende il colore del testo */
export const isNearBlack = (hex: string) => {
    const value = Number.parseInt(hex, 16)
    return ((value >> 16) & 0xff) < 0x40 && ((value >> 8) & 0xff) < 0x40 && (value & 0xff) < 0x40
}

/** Grigio medio leggibile su entrambi i temi, per le immagini (data URI) che non possono usare currentColor */
const NEUTRAL_HEX = "8B8B96"

/**
 * Il logo come data URI, per i componenti che accettano solo l'URL di un'immagine (es. le opzioni di SelectField).
 */
export const technologyIconUrl = (technology: Technology) => {
    const icon = TECHNOLOGY_ICONS[technology]
    const svg = icon
        ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#${isNearBlack(icon.hex) ? NEUTRAL_HEX : icon.hex}" d="${icon.path}"/></svg>`
        : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10.5" fill="none" stroke="#${NEUTRAL_HEX}" stroke-width="2"/><text x="12" y="16.5" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="700" fill="#${NEUTRAL_HEX}">${technologyMonogram(technology)}</text></svg>`
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
