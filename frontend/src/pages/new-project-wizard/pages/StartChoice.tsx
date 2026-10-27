import { IconTile } from "@flightroom/design-system"
import { ListChecks, Sparkles } from "lucide-react"
import { useTranslation } from "react-i18next"

interface StartChoiceProps {
    onAssistant: () => void
    onManual: () => void
}

/** The first screen of the wizard: describe the project to the assistant, or fill every step by hand */
const StartChoice: React.FC<StartChoiceProps> = ({ onAssistant, onManual }) => {
    const { t } = useTranslation()

    const choices = [
        { key: "assistant", icon: <Sparkles />, onClick: onAssistant },
        { key: "manual", icon: <ListChecks />, onClick: onManual }
    ]

    return (
        <div className="mt-8 flex flex-col gap-6">
            <div className="flex flex-col gap-1">
                <h2 data-testid="wizard-step-title" className="text-2xl font-semibold text-foreground">
                    {t("newProjectWizard.start.title")}
                </h2>
                <p className="text-foreground-secondary">{t("newProjectWizard.start.description")}</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
                {choices.map(choice => (
                    <button
                        key={choice.key}
                        type="button"
                        data-testid={`wizard-start-${choice.key}`}
                        onClick={choice.onClick}
                        className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-6 text-left shadow-card transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <IconTile icon={choice.icon} />
                        <span className="text-lg font-semibold text-foreground">{t(`newProjectWizard.start.${choice.key}_title`)}</span>
                        <span className="text-sm text-foreground-secondary">{t(`newProjectWizard.start.${choice.key}_description`)}</span>
                    </button>
                ))}
            </div>
        </div>
    )
}

export default StartChoice
