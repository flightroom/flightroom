import type { DomainLink } from "@/hooks/apiClients/useDomainLinksApi"
import { EMPTY_GALAXY_RADIUS, GALAXY_PADDING, RELATION_ARROW, RELATION_LABEL_AT } from "./constants"
import { layoutRelations } from "./layout"
import { BACKGROUND_STARS, type BodyColors, type Sky } from "./sky"
import type { Frame, Galaxy, GalaxyGeometry, Point, StarNode } from "./types"

/** Starts a frame: its clock, its zoom and what of the map it shows, in graph units, for the moons and ships to tell whether they are in view. */
export const startFrame = (frame: Frame, ctx: CanvasRenderingContext2D, scale: number, reducedMotion: boolean) => {
    const transform = ctx.getTransform()
    frame.id++
    frame.now = reducedMotion ? 0 : performance.now() / 1000
    frame.scale = scale
    frame.left = -transform.e / transform.a
    frame.top = -transform.f / transform.d
    frame.right = (ctx.canvas.width - transform.e) / transform.a
    frame.bottom = (ctx.canvas.height - transform.f) / transform.d
    frame.motion = false
}

/**
 * A relation between two galaxies: a thick line with an arrow at the target and its label in a pill
 * nearer the source, so the labels of a relation and of its way back do not cover each other.
 */
const paintRelation = (
    ctx: CanvasRenderingContext2D,
    { from, to, label, selected, scale, font, sky }: { from: Point; to: Point; label?: string; selected: boolean; scale: number; font: string; sky: Sky }
) => {
    const length = Math.hypot(to.x - from.x, to.y - from.y) || 1
    const ux = (to.x - from.x) / length
    const uy = (to.y - from.y) / length
    const color = `hsl(${sky.ink} / ${selected ? 0.95 : 0.55})`
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = (selected ? 3.5 : 2.5) / scale
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()

    const arrow = RELATION_ARROW / scale
    ctx.beginPath()
    ctx.moveTo(to.x, to.y)
    ctx.lineTo(to.x - ux * arrow - uy * arrow * 0.5, to.y - uy * arrow + ux * arrow * 0.5)
    ctx.lineTo(to.x - ux * arrow + uy * arrow * 0.5, to.y - uy * arrow - ux * arrow * 0.5)
    ctx.closePath()
    ctx.fill()

    if (!label) return
    ctx.font = `500 ${11 / scale}px ${font}`
    const width = ctx.measureText(label).width + 12 / scale
    const height = 18 / scale
    const x = from.x + (to.x - from.x) * RELATION_LABEL_AT
    const y = from.y + (to.y - from.y) * RELATION_LABEL_AT
    ctx.fillStyle = sky.space
    ctx.strokeStyle = `hsl(${sky.ink} / ${selected ? 0.8 : 0.3})`
    ctx.lineWidth = 1 / scale
    ctx.beginPath()
    ctx.roundRect(x - width / 2, y - height / 2, width, height, height / 2)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = `hsl(${sky.ink} / 0.9)`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(label, x, y)
}

interface SkyScene {
    galaxies: Galaxy[]
    membersByGalaxy: Map<string, StarNode[]>
    links: DomainLink[]
    focusedGalaxyId: string | null
    selectedLinkId: string | null
    linking: boolean
    linkSourceId: string | null
    /** Where the pointer is while a relation is drawn, in graph coordinates */
    pointer: Point | null
    font: string
    sky: Sky
    colors: BodyColors
}

/**
 * What lies under the worlds: the dust of the background, a halo and its labels for every galaxy, the relations
 * between them and the one being drawn. Returns where the galaxies and the relations were drawn, for the clicks.
 */
export const paintSky = (
    ctx: CanvasRenderingContext2D,
    scale: number,
    { galaxies, membersByGalaxy, links, focusedGalaxyId, selectedLinkId, linking, linkSourceId, pointer, font, sky, colors }: SkyScene
) => {
    // The sky is drawn in screen pixels, so it stays put while the map pans and zooms.
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    const ratio = window.devicePixelRatio || 1
    BACKGROUND_STARS.forEach((star, index) => {
        ctx.fillStyle = colors.dust[index]
        ctx.fillRect(star.x * ctx.canvas.width, star.y * ctx.canvas.height, star.size * ratio, star.size * ratio)
    })
    ctx.restore()

    const geometry = new Map<string, GalaxyGeometry>()
    for (const galaxy of galaxies) {
        const members = membersByGalaxy.get(galaxy.id) ?? []
        const x = members.length ? members.reduce((sum, node) => sum + (node.x ?? 0), 0) / members.length : galaxy.anchor.x
        const y = members.length ? members.reduce((sum, node) => sum + (node.y ?? 0), 0) / members.length : galaxy.anchor.y
        const r = members.length ? Math.max(...members.map(node => Math.hypot((node.x ?? 0) - x, (node.y ?? 0) - y) + node.reach)) + GALAXY_PADDING : EMPTY_GALAXY_RADIUS
        geometry.set(galaxy.id, { x, y, r })

        const hue = galaxy.paletteIndex === undefined ? sky.noDomain : sky.galaxies[galaxy.paletteIndex % sky.galaxies.length]
        const halo = ctx.createRadialGradient(x, y, 0, x, y, r)
        halo.addColorStop(0, `hsl(${hue} / ${sky.haloAlpha[0]})`)
        halo.addColorStop(0.6, `hsl(${hue} / ${sky.haloAlpha[1]})`)
        halo.addColorStop(1, `hsl(${hue} / 0)`)
        ctx.fillStyle = halo
        ctx.beginPath()
        ctx.arc(x, y, r, 0, 2 * Math.PI)
        ctx.fill()

        // A solid ring on the galaxy flown to or picked as the start of a relation, a dashed one on the
        // nebula and, while a relation is drawn, on every galaxy it can reach.
        const isPicked = galaxy.id === focusedGalaxyId || galaxy.id === linkSourceId
        if (isPicked || !galaxy.domainId || linking) {
            ctx.strokeStyle = `hsl(${hue} / ${isPicked ? 0.8 : 0.4})`
            ctx.lineWidth = (isPicked ? 1.5 : 1) / scale
            ctx.setLineDash(isPicked ? [] : [4 / scale, 4 / scale])
            ctx.stroke()
            ctx.setLineDash([])
        }

        // Labels keep the same size on screen at every zoom.
        ctx.textAlign = "center"
        ctx.textBaseline = "bottom"
        ctx.fillStyle = `hsl(${sky.ink} / 0.9)`
        ctx.font = `600 ${14 / scale}px ${font}`
        ctx.fillText(galaxy.name, x, y - r - 18 / scale)
        ctx.fillStyle = `hsl(${sky.ink} / 0.6)`
        ctx.font = `${11 / scale}px ${font}`
        ctx.fillText(galaxy.caption, x, y - r - 4 / scale)
    }

    const segments = layoutRelations(links, geometry, scale)
    for (const { link, from, to } of segments) {
        paintRelation(ctx, { from, to, label: link.label, selected: link._id === selectedLinkId, scale, font, sky })
    }

    const source = linkSourceId ? geometry.get(linkSourceId) : undefined
    if (source && pointer) {
        ctx.strokeStyle = `hsl(${sky.ink} / 0.7)`
        ctx.lineWidth = 2 / scale
        ctx.setLineDash([6 / scale, 4 / scale])
        ctx.beginPath()
        ctx.moveTo(source.x, source.y)
        ctx.lineTo(pointer.x, pointer.y)
        ctx.stroke()
        ctx.setLineDash([])
    }
    return { geometry, segments }
}
