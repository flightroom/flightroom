import { EmptyStateRow, Meter, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tooltip, TooltipContent, TooltipTrigger } from "@flightroom/design-system"
import { Cloud, Cog, Hammer, Link as LinkIcon, LucideIcon, Server, Sparkles } from "lucide-react"
import React, { useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { useWorkingAgents, WorkingAgentsIndicator } from "@/components/ai-agents/WorkingAgentsIndicator"
import useProjectAiModels from "@/components/assistant/useProjectAiModels"
import { Badge, Button } from "@/components/atoms"
import TechnologyLogo from "@/components/technology/TechnologyLogo"
import { CanaryType, Frontend, FrontendKind, HostedOn } from "@/hooks/apiClients/useFrontendsApi"
import { BuildDialog, CloneRepositoryPopover, FrontendKindBadge, isAiEditAvailable } from "@/pages/frontends/partials/components"
import { useIsProjectViewer } from "@/store/useProjectStore"
import { cn } from "@/utils/styleUtils"
import { frontendTechnologyOf } from "@/utils/technologies"
import { HOST_TYPE_LABEL_KEYS } from "../labels"

interface FrontendsTableProps {
    frontends: Frontend[]
}

const COLUMN_COUNT = 8

/** The host is a single value out of three, so it reads as an icon and spells itself out on hover. */
const HOST_TYPE_ICONS: Record<HostedOn, LucideIcon> = {
    [HostedOn.MFE_ORCHESTRATOR_HUB]: Cloud,
    [HostedOn.CUSTOM_URL]: LinkIcon,
    [HostedOn.CUSTOM_SOURCE]: Server
}

const HostCell: React.FC<{ host: Frontend["host"] }> = ({ host }) => {
    const { t } = useTranslation("platform")

    const Icon = HOST_TYPE_ICONS[host.type]
    const label = t(HOST_TYPE_LABEL_KEYS[host.type])

    return (
        <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
                <span className="inline-flex text-foreground-secondary" aria-label={label}>
                    <Icon className="size-4" />
                </span>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
        </Tooltip>
    )
}

/**
 * The canary column. On User enrols an explicit list of users instead of splitting traffic, so it gets
 * a badge: a share bar sitting at 0% would read as "nobody sees the canary".
 */
const CanaryCell: React.FC<{ canary: Frontend["canary"] }> = ({ canary }) => {
    const { t } = useTranslation("platform")

    if (!canary?.enabled) {
        return <span className="whitespace-nowrap italic text-foreground-secondary">{t("frontend.canary_none")}</span>
    }

    if (canary.type === CanaryType.ON_USER) {
        return <Badge variant="outline">{t("frontend.canary_enrolled_users")}</Badge>
    }

    const percentage = Math.min(100, Math.max(0, canary.percentage ?? 0))
    if (percentage <= 0) {
        return <span className="whitespace-nowrap italic text-foreground-secondary">{t("frontend.canary_none")}</span>
    }

    return (
        <div className="flex min-w-[7rem] items-center gap-2">
            {/* animated={false}: in tabella molte barre che si animano insieme distraggono, ed è il comportamento che questa cella aveva già */}
            <Meter className="max-w-20" value={percentage} label={t("frontend.canaryReleaseActive")} animated={false} />
            <span className="whitespace-nowrap text-xs tabular-nums text-foreground-secondary">
                {percentage}% {t("frontend.ofUsers")}
            </span>
        </div>
    )
}

/** A canary deployed by URL carries no version of its own, so the cell stays empty rather than lying. */
const CanaryVersionCell: React.FC<{ canary: Frontend["canary"] }> = ({ canary }) => {
    if (!canary?.enabled || !canary.version) {
        return <span className="text-foreground-secondary">—</span>
    }

    return <Badge variant="outline">{canary.version}</Badge>
}

const FrontendRow: React.FC<{ mfe: Frontend }> = ({ mfe }) => {
    const { t } = useTranslation("platform")
    const navigate = useNavigate()

    const [isBuildDialogOpen, setIsBuildDialogOpen] = useState(false)
    // A viewer may look, not release
    const isViewer = useIsProjectViewer()
    const hasRepository = Boolean(mfe.codeRepository?.enabled)
    const agents = useWorkingAgents(mfe._id)
    const aiAvailable = isAiEditAvailable(mfe, useProjectAiModels().enabled)
    // Served by its own container: Flightroom neither hosts it nor runs a canary for it
    const isDocker = mfe.kind === FrontendKind.DOCKER
    const openPath = aiAvailable ? `/frontend/${mfe._id}` : `/frontend/${mfe._id}/settings`
    const technology = frontendTechnologyOf(mfe)

    return (
        // The whole row opens the frontend, as a row of the backends table does.
        <TableRow className={cn("cursor-pointer border-divider hover:bg-primary/5", agents > 0 && "bg-primary/5")} onClick={() => navigate(openPath)}>
            {/* Capped so a long name or slug cannot push the action column out of view. */}
            <TableCell className="max-w-[16rem] font-medium">
                <div className="flex items-center gap-2">
                    {technology && <TechnologyLogo technology={technology} />}
                    <span className="truncate" title={mfe.name}>
                        {mfe.name}
                    </span>
                    <WorkingAgentsIndicator agents={agents} compact />
                </div>
            </TableCell>
            <TableCell className="max-w-[14rem] truncate text-foreground-secondary" title={mfe.slug}>
                {mfe.slug}
            </TableCell>
            <TableCell>
                <FrontendKindBadge frontend={mfe} className="whitespace-nowrap" />
            </TableCell>
            <TableCell>{mfe.version ? <Badge>{mfe.version}</Badge> : <span className="text-foreground-secondary">—</span>}</TableCell>
            <TableCell>{isDocker ? <span className="text-foreground-secondary">—</span> : <HostCell host={mfe.host} />}</TableCell>
            <TableCell>{isDocker ? <span className="text-foreground-secondary">—</span> : <CanaryCell canary={mfe.canary} />}</TableCell>
            <TableCell className="whitespace-nowrap">
                <CanaryVersionCell canary={mfe.canary} />
            </TableCell>
            {/* The buttons, and the dialog rendered from here, must not also open the frontend: React bubbles portal clicks too. */}
            <TableCell className="cursor-default whitespace-nowrap text-right" onClick={event => event.stopPropagation()}>
                <div className="flex justify-end gap-2">
                    <CloneRepositoryPopover frontend={mfe} />
                    {hasRepository && !isViewer && (
                        <Button variant="secondary" size="sm" onClick={() => setIsBuildDialogOpen(true)}>
                            <Hammer />
                            {t("frontend.card.build")}
                        </Button>
                    )}
                    <Button variant={aiAvailable ? "primary" : "secondary"} size="sm" onClick={() => navigate(openPath)}>
                        {aiAvailable ? <Sparkles /> : <Cog />}
                        {aiAvailable ? t("frontend.workspace.nav_ai") : t("common.configuration")}
                    </Button>
                </div>
                <BuildDialog open={isBuildDialogOpen} onOpenChange={setIsBuildDialogOpen} frontendId={mfe._id} frontendName={mfe.name} />
            </TableCell>
        </TableRow>
    )
}

export const FrontendsTable: React.FC<FrontendsTableProps> = ({ frontends }) => {
    const { t } = useTranslation("platform")

    return (
        <div className="overflow-hidden rounded-lg border-2 border-border bg-card">
            <Table>
                <TableHeader>
                    <TableRow className="bg-muted/60 hover:bg-muted/60">
                        <TableHead>{t("common.name")}</TableHead>
                        <TableHead>{t("frontend.slug")}</TableHead>
                        <TableHead>{t("frontend.kind.label")}</TableHead>
                        <TableHead>{t("frontend.version")}</TableHead>
                        <TableHead>{t("frontend.host")}</TableHead>
                        <TableHead>{t("frontend.canary_release")}</TableHead>
                        <TableHead>{t("frontend.canary_version")}</TableHead>
                        <TableHead className="text-right">{t("common.actions")}</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {frontends.length > 0 ? frontends.map(mfe => <FrontendRow key={mfe._id} mfe={mfe} />) : <EmptyStateRow colSpan={COLUMN_COUNT}>{t("frontend.no_frontends_found")}</EmptyStateRow>}
                </TableBody>
            </Table>
        </div>
    )
}

export default FrontendsTable
