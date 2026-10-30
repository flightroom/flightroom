import type { Backend } from "@/hooks/apiClients/useBackendsApi"
import type { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import type { MaintenanceAgent } from "@/hooks/apiClients/useMaintenanceAgentsApi"
import type { Resource } from "@/hooks/apiClients/useResourcesApi"
import { type MaintenanceStatus, maintenanceStatusOf } from "../maintenance"
import type { Hull } from "./theme"

/** A backend or a frontend some agent maintains, seen through the window */
export interface WorldSpot {
    key: string
    kind: "backend" | "frontend"
    /** Shortened to the room it has in the window */
    label: string
    name: string
    path: string
    x: number
    y: number
    r: number
    hue: string
    showLabel: boolean
}

export interface BaySpot {
    agent: MaintenanceAgent
    index: number
    x: number
    y: number
    status: MaintenanceStatus
    /** The keys of the worlds it maintains */
    targets: string[]
    resources: Resource[]
    /** Seconds: each bay breathes out of step with its neighbours */
    phase: number
}

export type Hovered = { kind: "bay"; id: string } | { kind: "world"; key: string } | null

export const PAD = 20
export const WINDOW_Y = 20
export const WINDOW_HEIGHT = { deck: 196, single: 150 }
export const STRIP_HEIGHT = 96
/** Under the window, the rail the beams cross before reaching the bays */
const RAIL_GAP = 48
export const BAY_W = 208
/** The art of a bay, then its name and its line of details */
export const BAY_ART_H = 186
export const BAY_H = 236
const GAP_X = 18
const GAP_Y = 34
/** Below it the deck turns into a list of cards: the bays, the beams and the labels would not fit */
export const COMPACT_WIDTH = 640
/** Canisters drawn by a bay; beyond them a "+N" tag */
export const CANISTER_SLOTS = [22, 40, 154, 172]
export const DIMMED_BAY = 0.38
export const DIMMED_WORLD = 0.28

/** A fixed sky: seeded, so the stars do not jump around at every mount. */
export const WINDOW_STARS = (() => {
    let seed = 11
    const random = () => {
        seed = (seed * 16807) % 2147483647
        return seed / 2147483647
    }
    return Array.from({ length: 160 }, (_, index) => ({
        x: random(),
        y: random(),
        r: random() < 0.88 ? 0.7 : 1.3,
        alpha: 0.2 + random() * 0.6,
        twinkle: index % 9 === 0,
        delay: random() * 4
    }))
})()

/** A stable spread from an id, so a bay keeps its rhythm across polls. */
const phaseOf = (id: string) => {
    let hash = 0
    for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 9973
    return (hash / 9973) * 4
}

export const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…` : text)

interface StationInput {
    agents: MaintenanceAgent[]
    backends: Backend[]
    frontends: Frontend[]
    resources: Resource[]
    width: number
    now: number
    windowHeight: number
    compact: boolean
    hull: Hull
    primary: string
}

/** Where the bays stand on the deck and the worlds in the window, and how tall the deck grows. */
export const layoutStation = ({ agents, backends, frontends, resources, width, now, windowHeight, compact, hull, primary }: StationInput) => {
    const backendsById = new Map(backends.map(backend => [backend._id!, backend]))
    const frontendsById = new Map(frontends.map(frontend => [frontend._id!, frontend]))
    const resourcesById = new Map(resources.map(resource => [resource._id!, resource]))

    // The bays, row by row, each row centred on the deck
    const columns = Math.max(1, Math.floor((width - 2 * PAD + GAP_X) / (BAY_W + GAP_X)))
    const deckTop = WINDOW_Y + windowHeight + RAIL_GAP
    const bays: BaySpot[] = agents.map((agent, index) => {
        const row = Math.floor(index / columns)
        const inRow = Math.min(columns, agents.length - row * columns)
        const left = (width - (inRow * BAY_W + (inRow - 1) * GAP_X)) / 2
        return {
            agent,
            index,
            x: left + (index % columns) * (BAY_W + GAP_X),
            y: deckTop + row * (BAY_H + GAP_Y),
            status: maintenanceStatusOf(agent, now),
            targets: [
                ...agent.backendIds.filter(target => backendsById.has(target)).map(target => `backend:${target}`),
                ...agent.frontendIds.filter(target => frontendsById.has(target)).map(target => `frontend:${target}`)
            ],
            resources: agent.resourceIds.flatMap(resourceId => resourcesById.get(resourceId) ?? []),
            phase: phaseOf(agent._id)
        }
    })
    const rows = Math.ceil(agents.length / columns)
    const height = deckTop + rows * BAY_H + Math.max(0, rows - 1) * GAP_Y + PAD

    // The worlds over the bays that maintain them, so the beams cross as little as they can
    const users = new Map<string, number[]>()
    for (const bay of bays) {
        for (const target of bay.targets) users.set(target, [...(users.get(target) ?? []), bay.x + BAY_W / 2])
    }
    const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
    const keys = [...users.keys()].sort((a, b) => average(users.get(a)!) - average(users.get(b)!))
    const inner = width - 2 * PAD - 48
    const spacing = keys.length ? inner / keys.length : inner
    const baseRadius = compact ? 6 : Math.max(7, Math.min(13, spacing * 0.15))
    const worlds: WorldSpot[] = keys.map((key, index) => {
        const [kind, targetId] = key.split(":") as ["backend" | "frontend", string]
        const member = kind === "backend" ? backendsById.get(targetId)! : frontendsById.get(targetId)!
        return {
            key,
            kind,
            label: truncate(member.name, Math.max(6, Math.floor(spacing / 6.6))),
            name: member.name,
            path: kind === "backend" ? `/backend/${targetId}` : `/frontend/${targetId}`,
            x: PAD + 24 + spacing * (index + 0.5),
            y: compact ? WINDOW_Y + windowHeight / 2 + (index % 2 ? -10 : 10) : WINDOW_Y + windowHeight * 0.6 + (index % 2 ? -14 : 12),
            r: baseRadius + Math.min(4, users.get(key)!.length - 1) * (compact ? 0.6 : 1.3),
            hue: kind === "backend" ? hull.backend : primary,
            showLabel: !compact && spacing >= 70
        }
    })
    return { bays, worlds, height, deckTop }
}

/** What the pointer or the focus is on lights up with what it is tied to; the rest dims. */
export const litOf = (hovered: Hovered, bays: BaySpot[]) => {
    const litBays = new Set<string>()
    const litWorlds = new Set<string>()
    if (hovered?.kind === "bay") {
        litBays.add(hovered.id)
        for (const target of bays.find(bay => bay.agent._id === hovered.id)?.targets ?? []) litWorlds.add(target)
    } else if (hovered?.kind === "world") {
        litWorlds.add(hovered.key)
        for (const bay of bays) if (bay.targets.includes(hovered.key)) litBays.add(bay.agent._id)
    }
    return { litBays, litWorlds, active: hovered !== null }
}
