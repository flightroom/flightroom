import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/atoms"
import useAiJobsApi from "@/hooks/apiClients/useAiJobsApi"
import { PROMPT_EXCERPT } from "./constants"
import type { Galaxy, Hovered, StarNode } from "./types"

interface GalaxyTooltipProps {
    target: Hovered
    galaxies: Galaxy[]
    worlds: StarNode[]
}

const promptExcerpt = (prompt: string) => {
    const line = prompt.trim().split("\n")[0]
    return line.length > PROMPT_EXCERPT ? `${line.slice(0, PROMPT_EXCERPT - 1).trimEnd()}…` : line
}

/** What the pointer is on: a world, a moon, a station or a ship, placed below it in screen pixels. */
const GalaxyTooltip: React.FC<GalaxyTooltipProps> = ({ target, galaxies, worlds }) => {
    const { t } = useTranslation()
    const aiJobsApi = useAiJobsApi()

    // The prompt of the agent under the pointer, asked for only then: the working list says on what an agent works, not what it does.
    const hoveredJobId = target.kind === "ship" && target.ship.job.kind === "job" ? target.ship.job.jobId : undefined
    const hoveredJobQuery = useQuery({
        queryKey: ["ai-job", hoveredJobId],
        queryFn: () => aiJobsApi.get(hoveredJobId!, { silent: true }),
        enabled: Boolean(hoveredJobId),
        retry: false,
        staleTime: 60_000
    })

    const nameOf = (id: string) => worlds.find(node => node.id === id)?.name ?? ""

    const renderContent = () => {
        if (target.kind === "moon") {
            const others = target.moon.users.filter(id => id !== target.moon.world.id).map(nameOf)
            return (
                <>
                    <span className="block truncate text-sm font-semibold text-card-foreground">{target.moon.name}</span>
                    <div className="text-foreground-secondary">{target.moon.label}</div>
                    <div className="mt-1 text-foreground-secondary">
                        {t("domains.galaxy.kind_resource")} · {t("domains.galaxy.moon_of", { name: target.moon.world.name })}
                    </div>
                    {others.length > 0 && <div className="mt-1 font-medium text-card-foreground">{t("domains.galaxy.moon_shared", { names: others.join(", ") })}</div>}
                </>
            )
        }
        if (target.kind === "station") {
            const { agent } = target.station
            return (
                <>
                    <span className="block truncate text-sm font-semibold text-card-foreground">{agent.name}</span>
                    <div className="text-foreground-secondary">
                        {t(agent.kind === "container" ? "domains.galaxy.station_container" : "domains.galaxy.station_job")} ·{" "}
                        {agent.schedule ? t("domains.galaxy.station_scheduled", { schedule: agent.schedule }) : t("domains.galaxy.station_standby")}
                    </div>
                    <div className="mt-1 text-foreground-secondary">{t("domains.galaxy.station_of", { name: target.station.world.name })}</div>
                    {target.station.status === "failed" && <div className="mt-1 font-medium text-destructive">{t("domains.galaxy.station_failed")}</div>}
                </>
            )
        }
        if (target.kind === "ship") {
            const prompt = hoveredJobQuery.data?.prompt
            let title = t("domains.galaxy.legend_agent")
            if (target.ship.job.kind === "request") title = t("domains.galaxy.ship_request")
            else if (prompt) title = t("domains.galaxy.ship_job", { prompt: promptExcerpt(prompt) })
            return (
                <>
                    <span className="block text-sm font-semibold text-card-foreground">{title}</span>
                    <div className="mt-1 text-foreground-secondary">{target.ship.world.name}</div>
                    {target.ship.extra > 0 && <div className="mt-1 font-medium text-primary-strong">{t("domains.galaxy.ship_more", { count: target.ship.extra })}</div>}
                </>
            )
        }
        const galaxy = galaxies.find(candidate => candidate.id === target.node.galaxyId)
        return (
            <>
                <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-card-foreground">{target.node.name}</span>
                    {target.node.version && <Badge variant="outline">{target.node.version}</Badge>}
                </div>
                <div className="text-foreground-secondary">{target.node.slug}</div>
                <div className="mt-1 text-foreground-secondary">
                    {t(target.node.kind === "backend" ? "domains.galaxy.kind_backend" : "domains.galaxy.kind_frontend")}
                    {galaxy && ` · ${galaxy.name}`}
                </div>
                {target.node.canary !== undefined && <div className="mt-1 font-medium text-warning">{t("domains.galaxy.canary", { percentage: target.node.canary })}</div>}
            </>
        )
    }

    return (
        <div
            className="pointer-events-none absolute z-10 min-w-48 max-w-72 -translate-x-1/2 rounded-md border border-border bg-card px-3 py-2 text-xs shadow-md"
            // Below a world and its glow, below a moon and its label
            style={{ left: target.x, top: target.y + (target.kind === "world" ? target.node.radius * 2 + 16 : 28) }}
        >
            {renderContent()}
        </div>
    )
}

export default GalaxyTooltip
