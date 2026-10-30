import { Link2, LocateFixed, Trash2, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import ForceGraph2D, { ForceGraphMethods } from "react-force-graph-2d"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import useOpenAgentJob from "@/components/ai-agents/useOpenAgentJob"
import { Button } from "@/components/atoms"
import { Backend } from "@/hooks/apiClients/useBackendsApi"
import { DomainLink } from "@/hooks/apiClients/useDomainLinksApi"
import { Domain } from "@/hooks/apiClients/useDomainsApi"
import { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import type { Resource } from "@/hooks/apiClients/useResourcesApi"
import useIsDark from "@/hooks/useIsDark"
import { resourcePath } from "@/pages/resources/partials/resources"
import { FIT_MS, FIT_PADDING, GALAXY_HIT_REACH, MAX_GALAXY_ZOOM, RELATION_HIT } from "./domain-galaxy/constants"
import GalaxyBodyLists from "./domain-galaxy/GalaxyBodyLists"
import GalaxyLegend from "./domain-galaxy/GalaxyLegend"
import GalaxyTooltip from "./domain-galaxy/GalaxyTooltip"
import { distanceToSegment, bodyAt as findBodyAt } from "./domain-galaxy/hitTest"
import { paintSky, startFrame } from "./domain-galaxy/paintSky"
import { createWorldPainter } from "./domain-galaxy/paintWorld"
import { bodyColors, FALLBACK_PRIMARY, SKIES } from "./domain-galaxy/sky"
import type { Frame, Galaxy, GalaxyGeometry, Hovered, LaneLink, Point, RelationSegment, StarNode } from "./domain-galaxy/types"
import useGalaxyForces from "./domain-galaxy/useGalaxyForces"
import useGalaxyScene from "./domain-galaxy/useGalaxyScene"
import useMotionThrottle from "./domain-galaxy/useMotionThrottle"

interface DomainGalaxyProps {
    domains: Domain[]
    /** Left out on the map of the backends: only the backends are worlds there */
    frontends?: Frontend[]
    backends: Backend[]
    /** The relations drawn by hand between the domains */
    links: DomainLink[]
    /** A relation drawn from one domain to another, to be confirmed and saved; without it the relations are only shown */
    onLink?: (sourceDomainId: string, targetDomainId: string) => void
    /** A relation the user asked to delete */
    onUnlink?: (link: DomainLink) => void
    /** The resources of the project: drawn as moons of the backends shown that attach them */
    resources?: Resource[]
    /** The whole project (the domains page) or its backends only (the backends page): it changes the captions, the legend and the hints */
    scope?: "project" | "backend"
}

/** The same empty lists at every render: a new one would lay the whole map out again */
const NO_FRONTENDS: Frontend[] = []
const NO_RESOURCES: Resource[] = []

const readPrimaryHue = () => getComputedStyle(document.documentElement).getPropertyValue("--primary").trim() || FALLBACK_PRIMARY
const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches

/**
 * The whole project as a sky: every domain a galaxy, its frontends and backends the worlds in it,
 * members in no domain in a grey nebula. The resources a backend attaches are its moons, an agent at
 * work on a world a ship orbiting it. Links across two domains are drawn as bridges between the
 * galaxies, the ones the domain diagram has to leave out.
 */
const DomainGalaxy: React.FC<DomainGalaxyProps> = ({ domains, frontends = NO_FRONTENDS, backends, links, onLink, onUnlink, resources = NO_RESOURCES, scope = "project" }) => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const graphRef = useRef<ForceGraphMethods<StarNode, LaneLink>>(undefined)
    const containerRef = useRef<HTMLDivElement>(null)
    const geometryRef = useRef(new Map<string, GalaxyGeometry>())
    const fittedRef = useRef(false)
    const isBackend = scope === "backend"

    const [size, setSize] = useState({ width: 0, height: 0 })
    const [hovered, setHovered] = useState<Hovered | null>(null)
    const [focusedGalaxyId, setFocusedGalaxyId] = useState<string | null>(null)
    // Drawing a relation: the mode is on, then the domain it starts from is picked, then the one it goes to.
    const [linking, setLinking] = useState(false)
    const [linkSourceId, setLinkSourceId] = useState<string | null>(null)
    const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null)
    const pointerRef = useRef<Point | null>(null)
    // The world the force-graph has under the pointer, also while a moon or a ship takes the hover from it.
    const worldUnderPointerRef = useRef<StarNode | null>(null)
    const relationSegmentsRef = useRef<RelationSegment[]>([])
    const frameRef = useRef<Frame>({ id: 0, now: 0, scale: 1, left: 0, top: 0, right: 0, bottom: 0, motion: false, shipsPainted: -1 })
    const openAgentJob = useOpenAgentJob()
    const [primaryHue] = useState(readPrimaryHue)
    const [reducedMotion] = useState(prefersReducedMotion)
    const [font] = useState(() => getComputedStyle(document.body).fontFamily)
    const sky = SKIES[useIsDark() ? "dark" : "light"]
    const colors = useMemo(() => bodyColors(sky), [sky])

    useEffect(() => {
        const element = containerRef.current
        if (!element) return
        const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
        observer.observe(element)
        return () => observer.disconnect()
    }, [])

    const { galaxies, graphData, membersByGalaxy, moons, moonsByWorld, ships, agents, stations, stationsByWorld } = useGalaxyScene({ domains, frontends, backends, resources, isBackend })

    // The graph is only rendered once the container has a size, and the forces need it in place.
    const isGraphMounted = size.width > 0

    const hasBodies = moons.length > 0 || ships.length > 0 || stations.length > 0
    const { turning, engineStoppedRef, onRenderFramePost } = useMotionThrottle(graphRef, frameRef, { reducedMotion, hasBodies, linkSourceId, isGraphMounted, graphData })

    const hasBridges = graphData.links.some(link => link.bridge)
    const animated = !reducedMotion && (hasBridges || turning || graphData.nodes.some(node => node.canary !== undefined))

    useGalaxyForces(graphRef, galaxies, isGraphMounted, engineStoppedRef)

    const hoveredResourceId = hovered?.kind === "moon" ? hovered.moon.resourceId : null
    // What lights up with the hover: a world and its neighbours, every world a resource or ship's job touches.
    const neighbourIds = useMemo(() => {
        if (!hovered) return null
        if (hovered.kind === "moon") return new Set(hovered.moon.users)
        if (hovered.kind === "ship") return new Set(hovered.ship.worlds.map(world => world.id))
        if (hovered.kind === "station") return new Set([hovered.station.world.id])
        const ids = new Set([hovered.node.id])
        for (const link of graphData.links) {
            if (link.from === hovered.node.id) ids.add(link.to)
            if (link.to === hovered.node.id) ids.add(link.from)
        }
        return ids
    }, [hovered, graphData])

    const fitAll = useCallback(() => {
        setFocusedGalaxyId(null)
        if (graphData.nodes.length) graphRef.current?.zoomToFit(FIT_MS, FIT_PADDING)
    }, [graphData])

    const onEngineStop = useCallback(() => {
        engineStoppedRef.current = true
        if (fittedRef.current) return
        fittedRef.current = true
        fitAll()
    }, [fitAll, engineStoppedRef])

    const onRenderFramePre = useCallback(
        (ctx: CanvasRenderingContext2D, scale: number) => {
            startFrame(frameRef.current, ctx, scale, reducedMotion)
            const pointer = pointerRef.current
            const { geometry, segments } = paintSky(ctx, scale, { galaxies, membersByGalaxy, links, focusedGalaxyId, selectedLinkId, linking, linkSourceId, pointer, font, sky, colors })
            geometryRef.current = geometry
            relationSegmentsRef.current = segments
        },
        [galaxies, membersByGalaxy, focusedGalaxyId, font, sky, colors, links, selectedLinkId, linking, linkSourceId, reducedMotion]
    )

    const bodyAt = useCallback((point: Point) => findBodyAt(point, frameRef.current, ships, stations, moons), [ships, stations, moons])

    // Built once per change of what it paints rather than per node and per frame, when the force-graph calls it.
    const paintStar = useMemo(
        () => createWorldPainter({ worlds: graphData.nodes, moonsByWorld, stationsByWorld, ships, neighbourIds, hoveredResourceId, primaryHue, reducedMotion, font, sky, colors }, frameRef),
        [primaryHue, neighbourIds, reducedMotion, font, sky, colors, moonsByWorld, ships, stationsByWorld, graphData.nodes, hoveredResourceId]
    )

    const paintPointerArea = useCallback((node: StarNode, color: string, ctx: CanvasRenderingContext2D) => {
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(node.x ?? 0, node.y ?? 0, node.radius + 2, 0, 2 * Math.PI)
        ctx.fill()
    }, [])

    const laneHue = useCallback((link: LaneLink) => (link.bridge ? sky.bridge : link.kind === "backend" ? sky.backend : primaryHue), [primaryHue, sky])
    const isLit = useCallback((link: LaneLink) => hovered?.kind === "world" && (link.from === hovered.node.id || link.to === hovered.node.id), [hovered])

    const linkColor = useCallback(
        (link: LaneLink) => {
            const alpha = neighbourIds ? (isLit(link) ? 0.95 : 0.06) : link.bridge ? 0.75 : link.kind === "relation" ? 0.4 : 0.35
            return `hsl(${laneHue(link)} / ${alpha})`
        },
        [neighbourIds, isLit, laneHue]
    )

    // A new accessor hands every link new particles, which start their way over: only the hover changes it.
    const linkParticles = useCallback((link: LaneLink) => (!reducedMotion && (link.bridge || isLit(link)) ? 2 : 0), [reducedMotion, isLit])

    // A moon or a ship keeps the hover while the pointer is on it, over the world the force-graph reports.
    const onNodeHover = useCallback((node: StarNode | null) => {
        worldUnderPointerRef.current = node
        const graph = graphRef.current
        if (!node || !graph) return setHovered(previous => (previous?.kind === "world" ? null : previous))
        const position = graph.graph2ScreenCoords(node.x ?? 0, node.y ?? 0)
        setHovered(previous => (previous && previous.kind !== "world" ? previous : { kind: "world", node, x: position.x, y: position.y }))
    }, [])

    const stopLinking = useCallback(() => {
        setLinking(false)
        setLinkSourceId(null)
        pointerRef.current = null
    }, [])

    const startLinking = () => {
        setSelectedLinkId(null)
        setLinking(true)
    }

    useEffect(() => {
        if (!linking) return
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") stopLinking()
        }
        window.addEventListener("keydown", onKeyDown)
        return () => window.removeEventListener("keydown", onKeyDown)
    }, [linking, stopLinking])

    // While a relation is drawn a click picks a domain: the first one it starts from, the second one it goes to.
    const pickForLink = useCallback(
        (galaxy: Galaxy | undefined) => {
            // Empty space, the nebula of the members in no domain or the same domain again: start over
            if (!galaxy?.domainId || galaxy.domainId === linkSourceId) return setLinkSourceId(null)
            if (!linkSourceId) return setLinkSourceId(galaxy.domainId)
            onLink?.(linkSourceId, galaxy.domainId)
            stopLinking()
        },
        [linkSourceId, onLink, stopLinking]
    )

    /** A click on a moon opens its resource, on a station its maintenance agent, on a ship the work of its agent; false when it fell on none. */
    const openBody = useCallback(
        (point: Point) => {
            const body = bodyAt(point)
            if (body?.kind === "ship") openAgentJob(body.ship.job.jobId, body.ship.fallbackPath)
            if (body?.kind === "moon") navigate(resourcePath(body.moon.resourceId))
            if (body?.kind === "station") navigate(`/maintenance-agent/${body.station.agent._id}`)
            return Boolean(body)
        },
        [bodyAt, openAgentJob, navigate]
    )

    const onNodeClick = useCallback(
        (node: StarNode, event: MouseEvent) => {
            if (linking) return pickForLink(galaxies.find(galaxy => galaxy.id === node.galaxyId))
            // A ship or a moon drawn over a world: the click is for it.
            const graph = graphRef.current
            if (graph && openBody(graph.screen2GraphCoords(event.offsetX, event.offsetY))) return
            navigate(node.kind === "backend" ? `/backend/${node.id}` : `/frontend/${node.id}`)
        },
        [linking, pickForLink, galaxies, navigate, openBody]
    )

    // A first click on a galaxy flies to it, a second one opens the domain; a click on empty space shows everything again.
    const onBackgroundClick = useCallback(
        (event: MouseEvent) => {
            const graph = graphRef.current
            if (!graph) return
            const point = graph.screen2GraphCoords(event.offsetX, event.offsetY)
            // The nearest galaxy, reached also a little beyond its halo, where its labels are.
            const distance = (galaxy: Galaxy) => {
                const geometry = geometryRef.current.get(galaxy.id)
                return geometry ? Math.hypot(point.x - geometry.x, point.y - geometry.y) / (geometry.r * GALAXY_HIT_REACH) : Infinity
            }
            const hit = galaxies.filter(galaxy => distance(galaxy) <= 1).sort((a, b) => distance(a) - distance(b))[0]
            if (linking) return pickForLink(hit)
            if (openBody(point)) return
            // A relation is thin and runs between the halos, so it is looked for before the galaxies. Only shown, it cannot be picked.
            const reach = RELATION_HIT / graph.zoom()
            const relation = onUnlink && relationSegmentsRef.current.find(segment => distanceToSegment(point, segment.from, segment.to) <= reach)
            setSelectedLinkId(relation ? relation.link._id : null)
            if (relation) return
            if (!hit) return fitAll()
            // On the map of the backends a second click opens the backend nearest to it, not the domain:
            // a click on the name of a world, just outside its star, is for that backend.
            if (hit.id === focusedGalaxyId && isBackend) {
                const nearest = (membersByGalaxy.get(hit.id) ?? [])
                    .map(node => ({ node, distance: Math.hypot(point.x - (node.x ?? 0), point.y - (node.y ?? 0)) }))
                    .sort((a, b) => a.distance - b.distance)[0]
                if (nearest) navigate(`/backend/${nearest.node.id}`)
                return
            }
            if (hit.id === focusedGalaxyId && hit.domainId) return navigate(`/domain/${hit.domainId}`)
            const geometry = geometryRef.current.get(hit.id)!
            setFocusedGalaxyId(hit.id)
            graph.centerAt(geometry.x, geometry.y, FIT_MS)
            graph.zoom(Math.min(MAX_GALAXY_ZOOM, Math.min(size.width, size.height) / (2.6 * geometry.r)), FIT_MS)
        },
        [galaxies, membersByGalaxy, isBackend, focusedGalaxyId, fitAll, navigate, size, linking, pickForLink, openBody, onUnlink]
    )

    // The dashed line of a relation being drawn follows the pointer; otherwise the pointer looks for a moon or a ship,
    // which the force-graph does not know about.
    const onMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
        const graph = graphRef.current
        if (!graph) return
        const bounds = event.currentTarget.getBoundingClientRect()
        const point = graph.screen2GraphCoords(event.clientX - bounds.left - event.currentTarget.clientLeft, event.clientY - bounds.top - event.currentTarget.clientTop)
        if (linkSourceId) {
            pointerRef.current = point
            return
        }
        if (linking) return
        const body = bodyAt(point)
        setHovered(previous => {
            if (body) {
                const same =
                    (previous?.kind === "moon" && body.kind === "moon" && previous.moon === body.moon) ||
                    (previous?.kind === "ship" && body.kind === "ship" && previous.ship === body.ship) ||
                    (previous?.kind === "station" && body.kind === "station" && previous.station === body.station)
                if (same) return previous
                const at = body.kind === "moon" ? body.moon : body.kind === "ship" ? body.ship : body.station
                const position = graph.graph2ScreenCoords(at.x, at.y)
                return { ...body, x: position.x, y: position.y }
            }
            if (!previous || previous.kind === "world") return previous
            // Off a moon or a ship and back on the world under it.
            const world = worldUnderPointerRef.current
            if (!world) return null
            const position = graph.graph2ScreenCoords(world.x ?? 0, world.y ?? 0)
            return { kind: "world", node: world, x: position.x, y: position.y }
        })
    }

    const selectedLink = links.find(link => link._id === selectedLinkId)
    const domainName = (domainId: string) => galaxies.find(galaxy => galaxy.id === domainId)?.name ?? ""
    let linkingHint = t("domains.galaxy.link_pick_source")
    if (linkSourceId) linkingHint = t("domains.galaxy.link_pick_target", { source: domainName(linkSourceId) })

    return (
        <div
            ref={containerRef}
            className={`relative h-[calc(100vh-300px)] min-h-[420px] overflow-hidden rounded-lg border-2 border-border ${linking ? "[&_canvas]:!cursor-crosshair" : ""}`}
            style={{ backgroundColor: sky.space }}
            onMouseLeave={() => setHovered(null)}
            onMouseMove={onMouseMove}
        >
            <p className="sr-only">
                {isBackend ? t("domains.galaxy.summary_backend") : t("domains.galaxy.summary", { count: graphData.links.filter(link => link.bridge).length })}
                {agents.length > 0 && ` ${t("domains.galaxy.agents_summary", { count: agents.length })}`}
            </p>
            <GalaxyBodyLists agents={agents} stations={stations} onOpenAgent={agent => openAgentJob(agent.jobId, agent.fallbackPath)} />
            {isGraphMounted && (
                <ForceGraph2D<StarNode, LaneLink>
                    ref={graphRef}
                    width={size.width}
                    height={size.height}
                    graphData={graphData}
                    backgroundColor={sky.space}
                    nodeCanvasObject={paintStar}
                    nodePointerAreaPaint={paintPointerArea}
                    linkColor={linkColor}
                    linkWidth={link => (isLit(link) ? 1.6 : link.bridge ? 1.4 : 0.8)}
                    linkLineDash={link => (link.kind === "backend" ? [3, 2] : null)}
                    linkCurvature={link => (link.bridge ? 0.15 : 0)}
                    linkDirectionalParticles={linkParticles}
                    linkDirectionalParticleSpeed={0.005}
                    linkDirectionalParticleWidth={2.2}
                    linkDirectionalParticleColor={link => `hsl(${laneHue(link)})`}
                    onRenderFramePre={onRenderFramePre}
                    onRenderFramePost={onRenderFramePost}
                    onNodeHover={onNodeHover}
                    onNodeClick={onNodeClick}
                    onBackgroundClick={onBackgroundClick}
                    onEngineStop={onEngineStop}
                    // The tooltip is placed in screen pixels, so it would drift away from its star.
                    onZoom={() => setHovered(null)}
                    enableNodeDrag={false}
                    autoPauseRedraw={!animated && !linkSourceId}
                    warmupTicks={reducedMotion ? 300 : 0}
                    cooldownTicks={reducedMotion ? 0 : Infinity}
                    cooldownTime={4000}
                    minZoom={0.2}
                    maxZoom={8}
                />
            )}

            {/* Without the tool to draw them, the relations are in the legend only when there are some */}
            <GalaxyLegend isBackend={isBackend} moons={moons.length > 0} relations={Boolean(onLink) || links.length > 0} stations={stations.length > 0} ships={ships.length > 0} />
            <div className="absolute top-3 right-3 flex items-center gap-2">
                {onLink && (
                    <Button
                        variant={linking ? "primary" : "secondary"}
                        size="sm"
                        aria-pressed={linking}
                        disabled={domains.length < 2}
                        onClick={linking ? stopLinking : startLinking}
                        dataTestId="domain-galaxy-link"
                    >
                        <Link2 />
                        {t("domains.galaxy.link_action")}
                    </Button>
                )}
                <Button variant="secondary" size="icon" aria-label={t("domains.galaxy.recenter")} title={t("domains.galaxy.recenter")} onClick={fitAll}>
                    <LocateFixed />
                </Button>
            </div>
            <p
                className={`pointer-events-none absolute right-3 bottom-3 max-w-sm rounded-md border bg-card px-3 py-2 text-xs shadow-sm ${linking ? "border-primary font-medium text-card-foreground" : "border-border text-foreground-secondary"}`}
                aria-live="polite"
            >
                {linking ? linkingHint : t(isBackend ? "domains.galaxy.hint_backend" : "domains.galaxy.hint")}
            </p>

            {selectedLink && onUnlink && (
                <div className="absolute bottom-3 left-3 z-10 flex items-center gap-3 rounded-md border border-border bg-card py-1.5 pr-1.5 pl-3 text-sm shadow-md">
                    <span className="font-medium text-card-foreground">
                        {domainName(selectedLink.sourceDomainId)} → {domainName(selectedLink.targetDomainId)}
                    </span>
                    {selectedLink.label && <span className="text-foreground-secondary">{selectedLink.label}</span>}
                    <Button variant="ghost" size="icon" aria-label={t("domains.galaxy.link_delete")} title={t("domains.galaxy.link_delete")} onClick={() => onUnlink(selectedLink)}>
                        <Trash2 className="text-destructive" />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={t("domains.galaxy.link_close")} title={t("domains.galaxy.link_close")} onClick={() => setSelectedLinkId(null)}>
                        <X />
                    </Button>
                </div>
            )}

            {hovered && <GalaxyTooltip target={hovered} galaxies={galaxies} worlds={graphData.nodes} />}
        </div>
    )
}

export default DomainGalaxy
