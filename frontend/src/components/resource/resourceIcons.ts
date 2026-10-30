import { ArrowRightLeft, Box, Braces, Database, FolderOpen, HardDrive, KeyRound, type LucideIcon, Mail, Mic, Sparkles } from "lucide-react"
import { type SimpleIcon, siAuth0, siClaude, siGooglebigquery, siGooglecloud, siGooglegemini, siMariadb, siMongodb, siMysql, siOpenapiinitiative, siPostgresql, siRedis } from "simple-icons"
import { isNearBlack } from "@/components/technology/technologyIcons"
import type { Resource } from "@/hooks/apiClients/useResourcesApi"

/** Quanto basta per scegliere l'icona: una Resource intera va bene cosi' com'e' */
export interface ResourceIconSource {
    type: string
    variant?: string
    /** Il motore di un database; se manca si legge dai campi */
    engine?: string
    fields?: Resource["fields"]
}

/**
 * Solo le icone usate, cosi' il bundle non si porta dietro tutto simple-icons. Mancano (tolte da simple-icons):
 * SQL Server, Oracle, Amazon S3/AWS, Azure e OpenAI, che restano sull'icona generica del tipo. Mappe e non
 * oggetti: un id che arriva dal backend non deve pescare le proprieta' di Object (es. "constructor").
 */
const ENGINE_BRANDS = new Map<string, SimpleIcon>([
    ["POSTGRESQL", siPostgresql],
    ["MYSQL", siMysql],
    ["MARIADB", siMariadb]
])
/** Per `tipo.variante` */
const VARIANT_BRANDS = new Map<string, SimpleIcon>([
    ["storage.google", siGooglecloud],
    ["serviceAccount.jsonKey", siGooglecloud],
    ["ai.anthropic", siClaude],
    ["ai.google", siGooglegemini]
])
const TYPE_BRANDS = new Map<string, SimpleIcon>([
    ["mongodb", siMongodb],
    ["bigquery", siGooglebigquery],
    ["redis", siRedis],
    ["auth0", siAuth0],
    ["api", siOpenapiinitiative]
])

/** L'icona generica di ogni tipo senza marchio; un tipo aggiunto dopo prende Box */
const TYPE_ICONS = new Map<string, LucideIcon>([
    ["database", Database],
    ["cosmosdb", Database],
    ["storage", HardDrive],
    ["serviceAccount", KeyRound],
    ["ai", Sparkles],
    ["smtp", Mail],
    ["sharepoint", FolderOpen],
    ["speech", Mic],
    ["serviceBus", ArrowRightLeft],
    ["generic", Braces]
])

/** Le stesse icone di lucide come markup, per i data URI: lucide-react esporta solo i componenti */
const TYPE_ICON_MARKUP = new Map<string, string>(
    Object.entries({
        database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
        cosmosdb: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
        storage:
            '<path d="M10 16h.01"/><path d="M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M21.946 12.013H2.054"/><path d="M6 16h.01"/>',
        serviceAccount:
            '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
        ai: '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><path d="M20 2v4"/><path d="M22 4h-4"/><circle cx="4" cy="20" r="2"/>',
        smtp: '<path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"/><rect x="2" y="4" width="20" height="16" rx="2"/>',
        sharepoint:
            '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
        speech: '<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>',
        serviceBus: '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
        generic: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>'
    })
)
const BOX_MARKUP =
    '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'

/** Il motore di un database, dal campo `engine` se non e' passato a parte */
export const resourceEngine = (source: ResourceIconSource) => source.engine ?? source.fields?.engine?.value

/** Il marchio del fornitore o del motore concreto, se simple-icons lo ha */
export const resourceBrand = (source: ResourceIconSource): SimpleIcon | undefined =>
    (source.type === "database" ? ENGINE_BRANDS.get(resourceEngine(source) ?? "") : undefined) ?? VARIANT_BRANDS.get(`${source.type}.${source.variant}`) ?? TYPE_BRANDS.get(source.type)

/** L'icona lucide del tipo, per quando non c'e' un marchio */
export const resourceTypeIcon = (type: string): LucideIcon => TYPE_ICONS.get(type) ?? Box

/** L'icona lucide del tipo come markup SVG (solo gli elementi, griglia 24x24, a tratto), per chi la disegna da se' (es. su un canvas) */
export const resourceTypeGlyph = (type: string) => TYPE_ICON_MARKUP.get(type) ?? BOX_MARKUP

/** Grigio medio leggibile su entrambi i temi, per le immagini (data URI) che non possono usare currentColor */
const NEUTRAL_HEX = "8B8B96"

/** L'icona come data URI, per i componenti che accettano solo l'URL di un'immagine (es. le opzioni di SelectField) */
export const resourceIconUrl = (source: ResourceIconSource) => {
    const brand = resourceBrand(source)
    const svg = brand
        ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#${isNearBlack(brand.hex) ? NEUTRAL_HEX : brand.hex}" d="${brand.path}"/></svg>`
        : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" color="#${NEUTRAL_HEX}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${TYPE_ICON_MARKUP.get(source.type) ?? BOX_MARKUP}</svg>`
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
