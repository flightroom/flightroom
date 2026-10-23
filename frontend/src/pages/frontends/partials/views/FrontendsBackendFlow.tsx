import { EmptyState } from "@flightroom/design-system"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { applyEdgeChanges, Background, Connection, Controls, Edge, EdgeChange, Handle, Node, NodeProps, Panel, Position, ReactFlow } from "@xyflow/react"
import { CirclePlus, Server } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { Badge, Button } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import TechnologyLogo from "@/components/technology/TechnologyLogo"
import useBackendsApi, { Backend } from "@/hooks/apiClients/useBackendsApi"
import useFrontendsApi, { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import useProjectStore from "@/store/useProjectStore"
import useThemeStore, { ThemeEnum } from "@/store/useThemeStore"
import { backendTechnologyOf, frontendTechnologyOf, type Technology } from "@/utils/technologies"
import "@xyflow/react/dist/style.css"

interface FrontendsBackendFlowProps {
    frontends: Frontend[]
}

interface LinkNodeData extends Record<string, unknown> {
    name: string
    slug: string
    version?: string
    technology?: Technology
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

/** A column heading, drawn in the canvas so it pans and zooms with the column under it. */
const ColumnLabelNode: React.FC<NodeProps<Node<{ label: string }>>> = ({ data }) => <div className="w-60 text-xs font-semibold uppercase tracking-wide text-foreground-secondary">{data.label}</div>

/** Defined once, outside the component: React Flow remounts every node when this object changes identity. */
const NODE_TYPES = {
    columnLabel: ColumnLabelNode,
    frontend: (props: NodeProps<Node<LinkNodeData>>) => <LinkNode {...props} side="frontend" />,
    backend: (props: NodeProps<Node<LinkNodeData>>) => <LinkNode {...props} side="backend" />
}

const COLUMN_X = { frontend: 0, backend: 480 }
const ROW_GAP = 90
const LABEL_Y = -50
const FIT_VIEW_OPTIONS = { padding: 0.2, maxZoom: 1 }
const EDGE_STYLE = { stroke: "hsl(var(--primary))", strokeWidth: 2 }
const DELETE_KEYS = ["Backspace", "Delete"]
/** One empty list for every render: a fresh `[]` would rebuild the edges, and reset them, on each one. */
const NO_BACKENDS: Backend[] = []

const THEME_TO_COLOR_MODE = {
    [ThemeEnum.LIGHT]: "light",
    [ThemeEnum.DARK]: "dark",
    [ThemeEnum.SYSTEM]: "system"
} as const

const edgeId = (frontendId: string, backendId: string) => `${frontendId}->${backendId}`

/**
 * Which frontend calls which backend: frontends on the left, the backend containers
 * in a column of their own on the right. The links are drawn by hand, since nothing in a build says
 * which API a frontend talks to.
 */
export const FrontendsBackendFlow: React.FC<FrontendsBackendFlowProps> = ({ frontends }) => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const projectId = useProjectStore(state => state.project?._id)
    const frontendsApi = useFrontendsApi()
    const backendsApi = useBackendsApi()
    const { theme } = useThemeStore()

    const backendsQuery = useQuery({
        queryKey: ["backends", projectId],
        queryFn: backendsApi.getAll,
        enabled: !!projectId
    })
    const backends = backendsQuery.data ?? NO_BACKENDS

    // The headings are keyed on the language, so they are the only nodes a language switch rebuilds.
    const nodes = useMemo<Node[]>(
        () => [
            ...(["frontend", "backend"] as const).map(side => ({
                id: `label-${side}`,
                type: "columnLabel",
                data: { label: t(side === "frontend" ? "frontend.backendLinks.frontendsColumn" : "frontend.backendLinks.backendsColumn") },
                position: { x: COLUMN_X[side], y: LABEL_Y },
                selectable: false,
                connectable: false,
                deletable: false
            })),
            ...frontends.map((mfe, index) => ({
                id: mfe._id!,
                type: "frontend",
                data: { name: mfe.name, slug: mfe.slug, version: mfe.version, technology: frontendTechnologyOf(mfe) },
                position: { x: COLUMN_X.frontend, y: index * ROW_GAP },
                deletable: false
            })),
            ...backends.map((backend, index) => ({
                id: backend._id!,
                type: "backend",
                data: { name: backend.name, slug: backend.slug, version: backend.version, technology: backendTechnologyOf(backend) },
                position: { x: COLUMN_X.backend, y: index * ROW_GAP },
                deletable: false
            }))
        ],
        [frontends, backends, t]
    )

    // Links to a backend deleted since are left out: there is no node to draw them to.
    const savedEdges = useMemo<Edge[]>(() => {
        const backendIds = new Set(backends.map(backend => backend._id))
        return frontends.flatMap(mfe =>
            (mfe.backendIds ?? []).filter(backendId => backendIds.has(backendId)).map(backendId => ({ id: edgeId(mfe._id!, backendId), source: mfe._id!, target: backendId, style: EDGE_STYLE }))
        )
    }, [frontends, backends])

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
        },
        [navigate]
    )

    return (
        <ApiStatusHandler queries={[backendsQuery]}>
            {backends.length === 0 ? (
                <EmptyState
                    variant="outlined"
                    size="lg"
                    tone="primary"
                    icon={<Server />}
                    title={t("frontend.backendLinks.noBackendsTitle")}
                    description={t("frontend.backendLinks.noBackendsDescription")}
                    actions={
                        <Button onClick={() => navigate("/backend/new")}>
                            <CirclePlus />
                            {t("frontend.backendLinks.createBackend")}
                        </Button>
                    }
                />
            ) : (
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
                            {t("frontend.backendLinks.hint")}
                        </Panel>
                        <Background gap={16} color="hsl(var(--divider))" />
                        <Controls showInteractive={false} />
                    </ReactFlow>
                </div>
            )}
        </ApiStatusHandler>
    )
}

export default FrontendsBackendFlow
