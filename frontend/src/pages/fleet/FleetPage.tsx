import { Card, EmptyState } from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { CirclePlus, Ship } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import AnswerUsage from "@/components/assistant/AnswerUsage"
import useProjectAiModels from "@/components/assistant/useProjectAiModels"
import { Button } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import SinglePageLayout from "@/components/SinglePageLayout"
import useAiMissionsApi, { AiMissionView, isAiMissionBusy, MISSIONS_POLL_INTERVAL_MS } from "@/hooks/apiClients/useAiMissionsApi"
import useProjectStore, { useIsProjectViewer } from "@/store/useProjectStore"
import { MissionAuthor, MissionCounts, MissionModeBadge, MissionProgress, MissionStatusBadge, missionErrorMessage } from "./partials/missionShared"
import NewMissionDialog from "./partials/NewMissionDialog"

const MissionCard: React.FC<{ mission: AiMissionView }> = ({ mission }) => {
    const { t } = useTranslation()
    return (
        // The prompt is the link; it stretches over the whole card, so the card opens on a click anywhere.
        <Card className="relative flex flex-col gap-3 p-4 transition-colors duration-200 focus-within:border-primary hover:border-primary" data-testid={`fleet-mission-${mission._id}`}>
            <div className="flex flex-wrap items-center gap-2">
                <MissionStatusBadge status={mission.status} />
                <MissionModeBadge mode={mission.mode} />
                <span className="ml-auto">
                    <MissionAuthor mission={mission} />
                </span>
            </div>
            <Link
                to={`/fleet/${mission._id}`}
                title={mission.prompt}
                className="line-clamp-2 break-words font-medium text-foreground after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
            >
                {mission.prompt}
            </Link>
            <MissionProgress mission={mission} />
            <MissionCounts counts={mission.counts} />
            <AnswerUsage usage={mission.usage} label={t("fleet.usage_label")} hint={t("fleet.usage_hint")} />
        </Card>
    )
}

/** The missions of the project, newest first: the same request run by agents on many repositories. */
const FleetPage: React.FC = () => {
    const { t } = useTranslation()
    const projectId = useProjectStore(state => state.project?._id)
    const isViewer = useIsProjectViewer()
    const assistantEnabled = useProjectAiModels().enabled
    const aiMissionsApi = useAiMissionsApi()
    const [newMissionOpen, setNewMissionOpen] = useState(false)
    const canCreate = assistantEnabled && !isViewer

    const missionsQuery = useQuery({
        queryKey: ["ai-missions", projectId],
        queryFn: () => aiMissionsApi.list(undefined, { customErrorMessage: error => missionErrorMessage(t, error, "load") }),
        enabled: Boolean(projectId),
        refetchInterval: query => (query.state.data?.some(isAiMissionBusy) ? MISSIONS_POLL_INTERVAL_MS : false)
    })
    const missions = missionsQuery.data

    const newMissionButton = canCreate && (
        <Button variant="primary" onClick={() => setNewMissionOpen(true)} dataTestId="fleet-new-mission">
            <CirclePlus />
            {t("fleet.new_mission")}
        </Button>
    )

    return (
        <SinglePageLayout title={t("fleet.title")} description={t("fleet.description")} right={missions && missions.length > 0 && newMissionButton}>
            {/* Only the first load goes through the handler: it takes a background refetch for a load and would blink at every poll. */}
            {missions ? (
                missions.length === 0 ? (
                    <EmptyState
                        variant="outlined"
                        size="lg"
                        tone="primary"
                        icon={<Ship />}
                        title={t("fleet.empty_title")}
                        description={t("fleet.empty_description")}
                        actions={newMissionButton || undefined}
                    />
                ) : (
                    <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,360px),1fr))] gap-4" aria-label={t("fleet.list_label")}>
                        {missions.map(mission => (
                            <li key={mission._id} className="min-w-0">
                                <MissionCard mission={mission} />
                            </li>
                        ))}
                    </ul>
                )
            ) : (
                <ApiStatusHandler queries={[missionsQuery]}>{null}</ApiStatusHandler>
            )}
            {projectId && canCreate && <NewMissionDialog projectId={projectId} open={newMissionOpen} onOpenChange={setNewMissionOpen} />}
        </SinglePageLayout>
    )
}

export default FleetPage
