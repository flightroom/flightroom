import { useQuery } from "@tanstack/react-query"
import { Boxes, FolderPlus, GitBranch, Layers, Users, X } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/atoms"
import MainLogo from "@/components/MainLogo"
import PageHead from "@/components/PageHead"
import useAiModelsApi, { AVAILABLE_AI_MODELS_QUERY_KEY } from "@/hooks/apiClients/useAiModelsApi"
import { ProjectDraft } from "@/hooks/apiClients/useAssistantApi"
import { Project } from "@/hooks/apiClients/useProjectApi"
import useBranding from "@/hooks/useBranding"
import useOrganizationStore from "@/store/useOrganizationStore"
import useProjectStore from "@/store/useProjectStore"
import CodeRepositories from "./pages/CodeRepositories"
import Completed from "./pages/Completed"
import Domains from "./pages/Domains"
import Environments from "./pages/Environments"
import MainData from "./pages/MainData"
import ProjectDraftAssistant from "./pages/ProjectDraftAssistant"
import StartChoice from "./pages/StartChoice"
import TeamMates from "./pages/TeamMates"
import { WizardStepMeta, WizardStepper } from "./pages/wizardShared"

export interface NewProjectWizardProps {
    mountPoint: string
    /** When provided the wizard runs embedded (e.g. first-run): no close button, and completion is handled via this callback instead of router navigation. */
    onComplete?: () => void
}

/** choose: describe the project to the assistant or fill the steps by hand; assistant: the conversation; steps: the wizard */
type Mode = "choose" | "assistant" | "steps"

const NewProjectWizard: React.FC<NewProjectWizardProps> = ({ onComplete }) => {
    const { t } = useTranslation()
    const branding = useBranding()
    const navigate = useNavigate()

    const STEPS: WizardStepMeta[] = [
        { key: "name", label: t("newProjectWizard.steps.name"), icon: <FolderPlus className="size-5" /> },
        { key: "environments", label: t("newProjectWizard.steps.environments"), icon: <Layers className="size-5" /> },
        { key: "domains", label: t("newProjectWizard.steps.domains"), icon: <Boxes className="size-5" /> },
        { key: "repositories", label: t("newProjectWizard.steps.repositories"), icon: <GitBranch className="size-5" /> },
        { key: "collaborators", label: t("newProjectWizard.steps.collaborators"), icon: <Users className="size-5" /> }
    ]
    const embedded = Boolean(onComplete)
    const projectStore = useProjectStore()
    const organizationId = useOrganizationStore(state => state.organization?._id)
    const aiModelsApi = useAiModelsApi()
    const [chosenMode, setChosenMode] = useState<Mode>()
    const [stepIndex, setStepIndex] = useState(0)
    const [completed, setCompleted] = useState(false)
    const [project, setProject] = useState<Project>()
    const [draft, setDraft] = useState<ProjectDraft>()

    // The project does not exist yet: the AIs are those of the organization it will belong to, and the draft takes its default.
    const availableQuery = useQuery({
        queryKey: [AVAILABLE_AI_MODELS_QUERY_KEY, "organization", organizationId],
        queryFn: () => aiModelsApi.availableForOrganization(organizationId!, { silent: true }),
        enabled: Boolean(organizationId)
    })
    const assistantAvailable = Boolean(organizationId) && Boolean(availableQuery.data?.models.length)
    const checkingAssistant = Boolean(organizationId) && availableQuery.isPending
    // Without an AI there is nothing to choose: the wizard starts at once.
    const defaultMode: Mode = assistantAvailable ? "choose" : "steps"
    const mode: Mode | undefined = chosenMode ?? (checkingAssistant ? undefined : defaultMode)

    const goNext = () => setStepIndex(i => Math.min(i + 1, STEPS.length - 1))
    const goBack = () => setStepIndex(i => Math.max(i - 1, 0))

    const onCreated = (created: Project) => {
        setProject(created)
        projectStore.setProject(created)
        goNext()
    }

    const finish = () => setCompleted(true)

    const renderStep = () => {
        switch (stepIndex) {
            case 0:
                return <MainData project={project} onCreated={onCreated} onNext={goNext} isFirst draft={draft} />
            case 1:
                return <Environments project={project} onNext={goNext} onBack={goBack} draft={draft} />
            case 2:
                return <Domains project={project} onNext={goNext} onBack={goBack} onSkip={goNext} draft={draft} />
            case 3:
                return <CodeRepositories project={project} onNext={goNext} onBack={goBack} onSkip={goNext} />
            case 4:
                return <TeamMates project={project} onNext={finish} onBack={goBack} onSkip={finish} />
            default:
                return null
        }
    }

    const renderBody = () => {
        if (completed) return <Completed project={project} onNext={() => undefined} onDone={onComplete} />
        if (mode === "choose") return <StartChoice onAssistant={() => setChosenMode("assistant")} onManual={() => setChosenMode("steps")} />
        if (mode === "assistant" && organizationId) {
            return (
                <ProjectDraftAssistant
                    organizationId={organizationId}
                    aiModelId={availableQuery.data?.defaultId}
                    onUse={proposal => {
                        setDraft(proposal)
                        setChosenMode("steps")
                    }}
                    onManual={() => setChosenMode("steps")}
                />
            )
        }
        if (mode === "steps") {
            return (
                <>
                    <WizardStepper steps={STEPS} current={stepIndex} />
                    {renderStep()}
                </>
            )
        }
        return null
    }

    return (
        <div className="w-screen h-screen overflow-y-auto bg-background">
            <PageHead title={t("newProjectWizard.subtitle")} />
            <div className="max-w-3xl mx-auto px-4 py-10 md:py-14">
                <header className="flex items-center gap-3 mb-10">
                    <MainLogo className="h-9 w-9" />
                    <div>
                        <h1 className="text-xl font-semibold text-foreground leading-tight">{branding.name}</h1>
                        <p className="text-sm text-foreground-secondary">{t("newProjectWizard.subtitle")}</p>
                    </div>
                    {!embedded && (
                        <Button
                            variant="ghost"
                            size="icon"
                            className="ml-auto text-muted-foreground hover:text-foreground"
                            aria-label={t("newProjectWizard.close")}
                            dataTestId="wizard-close"
                            onClick={() => navigate("/frontends")}
                        >
                            <X />
                        </Button>
                    )}
                </header>

                {renderBody()}
            </div>
        </div>
    )
}

export default NewProjectWizard
