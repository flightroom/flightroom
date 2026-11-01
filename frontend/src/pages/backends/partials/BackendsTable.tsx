import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@flightroom/design-system"
import { Info, Settings, Sparkles } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { ComponentWorkingAgents } from "@/components/ai-agents/WorkingAgentsIndicator"
import useProjectAiModels from "@/components/assistant/useProjectAiModels"
import CloneRepositoryPopover from "@/components/CloneRepositoryPopover"
import EntityCardActions from "@/components/EntityCardActions"
import TechnologyLogo from "@/components/technology/TechnologyLogo"
import type { Backend } from "@/hooks/apiClients/useBackendsApi"
import type { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import { isAiEditAvailable } from "@/pages/frontends/partials/components"
import { backendTechnologyOf, frontendTechnologyOf, type Technology } from "@/utils/technologies"
import { isBackendAiAvailable } from "./BackendHeader"

const NameCell: React.FC<{ id: string; name: string; technology?: Technology }> = ({ id, name, technology }) => (
    <TableCell className="max-w-[16rem] font-medium">
        <div className="flex min-w-0 items-center gap-2">
            {technology && <TechnologyLogo technology={technology} />}
            <span className="min-w-0 truncate" title={name}>
                {name}
            </span>
            <ComponentWorkingAgents componentId={id} compact />
        </div>
    </TableCell>
)

/** The buttons of its card: they must not also open the row, and React bubbles the clicks of the clone popover too. */
const ActionsCell: React.FC<React.ComponentProps<typeof EntityCardActions>> = props => (
    <TableCell className="w-56 cursor-default" onClick={event => event.stopPropagation()}>
        <EntityCardActions {...props} />
    </TableCell>
)

export const BackendsTable: React.FC<{ backends?: Backend[]; frontends?: Frontend[] }> = ({ backends = [], frontends = [] }) => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const assistantEnabled = useProjectAiModels().enabled

    return (
        <div className="overflow-hidden rounded-lg border-2 border-border bg-card">
            <Table>
                <TableHeader>
                    <TableRow className="bg-muted/60 hover:bg-muted/60">
                        <TableHead>{t("common.name")}</TableHead>
                        <TableHead>{t("backends.slug")}</TableHead>
                        <TableHead className="text-right">{t("common.actions")}</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {backends.map(backend => (
                        <TableRow key={backend._id} className="cursor-pointer border-divider hover:bg-primary/5" onClick={() => navigate(`/backend/${backend._id}`)}>
                            <NameCell id={backend._id} name={backend.name} technology={backendTechnologyOf(backend)} />
                            <TableCell className="max-w-[14rem] truncate text-foreground-secondary" title={backend.slug}>
                                {backend.slug}
                            </TableCell>
                            <ActionsCell
                                actions={[
                                    isBackendAiAvailable(backend, assistantEnabled) && {
                                        label: t("backends.nav_ai"),
                                        icon: <Sparkles />,
                                        onClick: () => navigate(`/backend/${backend._id}`),
                                        primary: true
                                    },
                                    { label: t("backends.nav_overview"), icon: <Info />, onClick: () => navigate(`/backend/${backend._id}/overview`) },
                                    { label: t("backends.nav_settings"), icon: <Settings />, onClick: () => navigate(`/backend/${backend._id}/settings`) }
                                ]}
                            >
                                <CloneRepositoryPopover frontend={backend} tile />
                            </ActionsCell>
                        </TableRow>
                    ))}
                    {frontends.map(frontend => (
                        <TableRow
                            key={frontend._id}
                            className="cursor-pointer border-divider hover:bg-primary/5"
                            onClick={() => navigate(isAiEditAvailable(frontend, assistantEnabled) ? `/frontend/${frontend._id}` : `/frontend/${frontend._id}/overview`)}
                        >
                            <NameCell id={frontend._id} name={frontend.name} technology={frontendTechnologyOf(frontend)} />
                            <TableCell className="max-w-[14rem] truncate text-foreground-secondary" title={frontend.slug}>
                                {frontend.slug}
                            </TableCell>
                            <ActionsCell
                                actions={[
                                    isAiEditAvailable(frontend, assistantEnabled) && {
                                        label: t("frontend.workspace.nav_ai"),
                                        icon: <Sparkles />,
                                        onClick: () => navigate(`/frontend/${frontend._id}`),
                                        primary: true
                                    },
                                    { label: t("frontend.workspace.nav_overview"), icon: <Info />, onClick: () => navigate(`/frontend/${frontend._id}/overview`) },
                                    { label: t("frontend.workspace.nav_settings"), icon: <Settings />, onClick: () => navigate(`/frontend/${frontend._id}/settings`) }
                                ]}
                            >
                                <CloneRepositoryPopover frontend={frontend} tile />
                            </ActionsCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    )
}

export default BackendsTable
