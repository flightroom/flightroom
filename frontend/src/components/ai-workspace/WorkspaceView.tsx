import { Box, List } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"

export type WorkspaceView = "classic" | "workshop"
const VIEW_KEY = "flightroom.aiWorkspace.view"
const VIEWS: WorkspaceView[] = ["classic", "workshop"]

/** The workshop, unless the user picked the classic view */
const readView = (): WorkspaceView => {
    try {
        return localStorage.getItem(VIEW_KEY) === "classic" ? "classic" : "workshop"
    } catch {
        return "workshop"
    }
}

const saveView = (view: WorkspaceView) => {
    try {
        localStorage.setItem(VIEW_KEY, view)
    } catch {
        // Storage blocked: the choice lasts as long as the page
    }
}

/** The look of the workspace the user picked, remembered across visits. */
export const useWorkspaceView = () => {
    const [view, setView] = useState<WorkspaceView>(readView)
    const changeView = (next: WorkspaceView) => {
        setView(next)
        saveView(next)
    }
    return [view, changeView] as const
}

export const ViewSwitch: React.FC<{ view: WorkspaceView; onChange: (view: WorkspaceView) => void }> = ({ view, onChange }) => {
    const { t } = useTranslation()
    return (
        <div role="group" aria-label={t("frontend.aiChange.workshop.view_label")} className="flex gap-1 rounded-md border border-divider p-0.5">
            {VIEWS.map(option => {
                const Icon = option === "classic" ? List : Box
                return (
                    <Button
                        key={option}
                        type="button"
                        size="sm"
                        variant={view === option ? "secondary" : "ghost"}
                        aria-pressed={view === option}
                        onClick={() => onChange(option)}
                        className="flex-1"
                        dataTestId={`ai-change-view-${option}`}
                    >
                        <Icon aria-hidden="true" />
                        {t(`frontend.aiChange.workshop.view.${option}`)}
                    </Button>
                )
            })}
        </div>
    )
}
