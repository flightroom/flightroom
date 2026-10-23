import { EmptyState } from "@flightroom/design-system"
import { useQueryClient } from "@tanstack/react-query"
import { applyEdgeChanges, Background, Connection, Controls, Edge, EdgeChange, Handle, MarkerType, Node, NodeProps, Panel, Position, ReactFlow } from "@xyflow/react"
import { CirclePlus, Server } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { Badge, Button } from "@/components/atoms"
import TechnologyLogo from "@/components/technology/TechnologyLogo"
import { Backend } from "@/hooks/apiClients/useBackendsApi"
import { Domain } from "@/hooks/apiClients/useDomainsApi"
import useFrontendsApi, { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import useProjectStore from "@/store/useProjectStore"
import useThemeStore, { ThemeEnum } from "@/store/useThemeStore"
import { backendTechnologyOf, frontendTechnologyOf, type Technology } from "@/utils/technologies"
import "@xyflow/react/dist/style.css"

interface DomainBackendLinksProps {
    domains: Domain[]
    frontends: Frontend[]
    backends: Backend[]
}

interface LinkNodeData extends Record<string, unknown> {
    name: string
    slug: string
    version?: string
    technology?: Technology
}

interface DomainBoxData extends Record<string, unknown> {
    name: string
    slug?: string
    frontendsLabel: string
    backendsLabel: string
}

/** Same look as the handles of the frontend graph, with a hit area larger than the dot. */
const HANDLE_CLASS = "!h-2.5 !w-2.5 !rounded-full !border-2 !border-card !bg-primary after:absolute after:-inset-2 after:content-['']"

/** Frontends only start a link and backends only end one, so a link always reads left to right. */
const LinkNode: React.FC<NodeProps<Node<LinkNodeData>> & { side: "frontend" | "backend" }> = ({ data, side }) => (
    <div className="flex w-60 items-center gap-2 rounded-lg border-2 border-border bg-card px-3 py-2.5 text-left shadow-sm">
        {side === "backend" && <Handle type="target" position={Position.Left} className={HANDLE_CLASS} />}
        {/* The logo of its technology when known; a backend without one keeps the generic server icon. */}
        {data.technology ? <TechnologyLogo technology={data.technology} /> : side === "backend" && <Server className="h-4 w-4 shrink-0 text-foreground-secondary" />}
        <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-card-foreground" title={data.name}>
                {data.name}
            </div>
            <div className="truncate text-xs text-foreground-secondary" title={data.slug}>
                {data.slug}
            </div>
        </div>
        {data.version && (
            <Badge variant="outline" className="shrink-0">
                {data.version}
            </Badge>
        )}
        {side === "frontend" && <Handle type="source" position={Position.Right} className={HANDLE_CLASS} />}
    </div>
)

/** The gap between the two columns is the lane every link runs in, also the ones that reach another box. */
const COLUMN_X = { frontend: 24, backend: 464 }
const BOX_WIDTH = 728
const BOX_HEADER = 84
const BOX_PADDING = 24
const NODE_HEIGHT = 60
const ROW_GAP = 90
/** The boxes are stacked: side by side, a link between two of them would run under the cards in between. */
const BOX_GAP = 60

/** The domain drawn as a box its frontends and backends sit in, with the heading of each column under its name. */
const DomainBox: React.FC<NodeProps<Node<DomainBoxData>>> = ({ data }) => (
    <div className="relative h-full w-full rounded-xl border-2 border-dashed border-primary/40 bg-primary/5">
        <div className="absolute left-6 right-6 top-3 min-w-0">
            <div className="truncate text-sm font-semibold text-foreground" title={data.name}>
                {data.name}
            </div>
            {data.slug && <div className="truncate font-mono text-xs text-foreground-secondary">{data.slug}</div>}
        </div>
        {(["frontend", "backend"] as const).map(side => (
            <div key={side} className="absolute top-14 w-60 text-xs font-semibold uppercase tracking-wide text-foreground-secondary" style={{ left: COLUMN_X[side] }}>
                {side === "frontend" ? data.frontendsLabel : data.backendsLabel}
            </div>
        ))}
    </div>
)

/** Defined once, outside the component: React Flow remounts every node when this object changes identity. */
const NODE_TYPES = {
    domain: DomainBox,
    frontend: (props: NodeProps<Node<LinkNodeData>>) => <LinkNode {...props} side="frontend" />,
    backend: (props: NodeProps<Node<LinkNodeData>>) => <LinkNode {...props} side="backend" />
}

const NO_DOMAIN = "none"
const FIT_VIEW_OPTIONS = { padding: 0.15, maxZoom: 1 }
const EDGE_STYLE = { stroke: "hsl(var(--primary))", strokeWidth: 2 }
/** A link from one domain to another is dashed, so it reads apart from those inside a box. */
const BRIDGE_STYLE = { ...EDGE_STYLE, strokeDasharray: "6 4" }
const EDGE_MARKER = { type: MarkerType.ArrowClosed, color: "hsl(var(--primary))", width: 16, height: 16 }
const DELETE_KEYS = ["Backspace", "Delete"]

const THEME_TO_COLOR_MODE = {
    [ThemeEnum.LIGHT]: "light",
    [ThemeEnum.DARK]: "dark",
    [ThemeEnum.SYSTEM]: "system"
} as const

const edgeId = (frontendId: string, backendId: string) => `${frontendId}->${backendId}`

/**
 * Which frontend calls which backend, drawn inside the domains they belong to: a box for each domain,
 * its frontends on the left and its backends on the right. A link may cross from one box to another.
 * The links are drawn by hand, since nothing in a build says which API a frontend talks to.
 */
export const DomainBackendLinks: React.FC<DomainBackendLinksProps> = ({ domains, frontends, backends }) => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const projectId = useProjectStore(state => state.project?._id)
    const frontendsApi = useFrontendsApi()
    const { theme } = useThemeStore()

    const boxOf = useMemo(() => {
        const domainIds = new Set(domains.map(domain => domain._id))
        return (domainId?: string) => (domainId && domainIds.has(domainId) ? domainId : NO_DOMAIN)
    }, [domains])

    const nodes = useMemo<Node[]>(() => {
        // The members in no domain get a box of their own, after the domains, only when there are any.
        const boxes = [
            ...domains.map(domain => ({ id: domain._id, name: domain.name, slug: domain.slug })),
            ...([...frontends, ...backends].some(member => boxOf(member.domainId) === NO_DOMAIN) ? [{ id: NO_DOMAIN, name: t("domains.no_domain"), slug: undefined }] : [])
        ].map(box => ({ ...box, frontends: frontends.filter(mfe => boxOf(mfe.domainId) === box.id), backends: backends.filter(backend => boxOf(backend.domainId) === box.id) }))

        let top = 0
        return boxes.flatMap(box => {
            const height = BOX_HEADER + (Math.max(box.frontends.length, box.backends.length, 1) - 1) * ROW_GAP + NODE_HEIGHT + BOX_PADDING
            const y = top
            top += height + BOX_GAP
            const parentId = `domain-${box.id}`
            const member = (kind: "frontend" | "backend", row: number) => ({
                type: kind,
                parentId,
                extent: "parent" as const,
                position: { x: COLUMN_X[kind], y: BOX_HEADER + row * ROW_GAP },
                deletable: false
            })
            return [
                {
                    id: parentId,
                    type: "domain",
                    data: { name: box.name, slug: box.slug, frontendsLabel: t("domains.links.frontendsColumn"), backendsLabel: t("domains.links.backendsColumn") },
                    position: { x: 0, y },
                    style: { width: BOX_WIDTH, height },
                    selectable: false,
                    connectable: false,
                    deletable: false
                },
                ...box.frontends.map((mfe, row) => ({
                    id: mfe._id!,
                    data: { name: mfe.name, slug: mfe.slug, version: mfe.version, technology: frontendTechnologyOf(mfe) },
                    ...member("frontend", row)
                })),
                ...box.backends.map((backend, row) => ({
                    id: backend._id!,
                    data: { name: backend.name, slug: backend.slug, version: backend.version, technology: backendTechnologyOf(backend) },
                    ...member("backend", row)
                }))
            ]
        })
    }, [domains, frontends, backends, boxOf, t])

    // Links to a backend not on the canvas, deleted or filtered out, are left out: there is no node to draw them to.
    const savedEdges = useMemo<Edge[]>(() => {
        const backendBoxes = new Map(backends.map(backend => [backend._id, boxOf(backend.domainId)]))
        return frontends.flatMap(mfe =>
            (mfe.backendIds ?? [])
                .filter(backendId => backendBoxes.has(backendId))
                .map(backendId => ({
                    id: edgeId(mfe._id!, backendId),
                    source: mfe._id!,
                    target: backendId,
                    style: backendBoxes.get(backendId) === boxOf(mfe.domainId) ? EDGE_STYLE : BRIDGE_STYLE,
                    markerEnd: EDGE_MARKER
                }))
        )
    }, [frontends, backends, boxOf])

    // Kept in state only so an edge can be selected, which is what lets the delete key remove it.
    const [edges, setEdges] = useState<Edge[]>(savedEdges)
    useEffect(() => setEdges(savedEdges), [savedEdges])

    const refresh = useCallback(() => queryClient.invalidateQueries({ queryKey: ["frontends-by-project-id", projectId] }), [queryClient, projectId])

    const onConnect = useCallback(
        async ({ source, target }: Connection) => {
            await frontendsApi.linkBackend(source, target)
            await refresh()
        },
        [frontendsApi.linkBackend, refresh]
    )

    const onEdgesChange = useCallback(
        async (changes: EdgeChange[]) => {
            setEdges(snapshot => applyEdgeChanges(changes, snapshot))
            const removed = changes.filter(change => change.type === "remove")
            if (removed.length === 0) return
            try {
                for (const change of removed) {
                    const edge = edges.find(e => e.id === change.id)
                    if (edge) await frontendsApi.unlinkBackend(edge.source, edge.target)
                }
            } finally {
                // On a failure too, so the canvas goes back to what is actually saved.
                await refresh()
            }
        },
        [edges, frontendsApi.unlinkBackend, refresh]
    )

    const onNodeDoubleClick = useCallback(
        (_event: React.MouseEvent, node: Node) => {
            if (node.type === "backend") navigate(`/backend/${node.id}`)
            if (node.type === "frontend") navigate(`/frontend/${node.id}`)
            if (node.type === "domain" && node.id !== `domain-${NO_DOMAIN}`) navigate(`/domain/${node.id.replace("domain-", "")}`)
        },
        [navigate]
    )

    if (backends.length === 0) {
        return (
            <EmptyState
                variant="outlined"
                size="lg"
                tone="primary"
                icon={<Server />}
                title={t("domains.links.noBackendsTitle")}
                description={t("domains.links.noBackendsDescription")}
                actions={
                    <Button onClick={() => navigate("/backend/new")}>
                        <CirclePlus />
                        {t("domains.links.createBackend")}
                    </Button>
                }
            />
        )
    }

    return (
        <div className="h-[calc(100vh-300px)] min-h-[420px] overflow-hidden rounded-lg border-2 border-border bg-card">
            <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={NODE_TYPES}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeDoubleClick={onNodeDoubleClick}
                nodesDraggable={false}
                deleteKeyCode={DELETE_KEYS}
                colorMode={THEME_TO_COLOR_MODE[theme]}
                fitView
                fitViewOptions={FIT_VIEW_OPTIONS}
                preventScrolling={false}
            >
                <Panel position="bottom-right" className="max-w-sm rounded-md border border-border bg-card px-3 py-2 text-xs text-foreground-secondary shadow-sm">
                    {t("domains.links.hint")}
                </Panel>
                <Background gap={16} color="hsl(var(--divider))" />
                <Controls showInteractive={false} />
            </ReactFlow>
        </div>
    )
}

export default DomainBackendLinks
