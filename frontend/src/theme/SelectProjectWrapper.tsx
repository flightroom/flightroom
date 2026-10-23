import { Spinner } from "@flightroom/design-system"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { PartyPopper } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import AuthenticationLayout from "@/authentication/components/AuthenticationLayout"
import { Button } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import PendingInvitationsList, { usePendingInvitationsQuery } from "@/components/PendingInvitationsList"
import ProjectPickerList from "@/components/ProjectPickerList"
import SwitchOrganizationButton from "@/components/SwitchOrganizationButton"
import useProjectApi, { Project } from "@/hooks/apiClients/useProjectApi"
import NewProjectWizard from "@/pages/new-project-wizard/NewProjectWizard"
import useOrganizationStore from "@/store/useOrganizationStore"
import useProjectStore from "@/store/useProjectStore"
import { clearProjectIdInLocalStorage, getProjectIdFromLocalStorage, setProjectIdInLocalStorage } from "@/utils/localStorageUtils"

interface SelectProjectFormProps {
    /** Left out for a member who may not create projects in this organization. */
    onCreateNewProject?: () => void
}

const SelectProjectForm: React.FC<SelectProjectFormProps> = ({ onCreateNewProject }) => {
    const { t } = useTranslation()
    const projectStore = useProjectStore()

    // Picking a row is the whole action, so it commits straight away instead of
    // making the user confirm a dropdown choice with a second click.
    const onSelectProject = (project: Project) => {
        projectStore.setProject(project)
        setProjectIdInLocalStorage(project._id)
    }

    return (
        <AuthenticationLayout title={t("project.select_project")} description={t("project.switch_desc")} size="lg">
            {/* Invitations come first: they are the only thing on this screen that still needs an answer. */}
            <PendingInvitationsList className="mb-4" />
            <ProjectPickerList projects={projectStore.projects ?? []} onSelect={onSelectProject} onCreateNew={onCreateNewProject} variant="grid" autoFocusSearch />
            {/* The only way out of this screen for a member of an organization that has nothing shared
                with them yet: the app header, where the switcher normally lives, is not rendered here. */}
            <div className="mt-4 flex justify-center border-t border-divider pt-4">
                <SwitchOrganizationButton />
            </div>
        </AuthenticationLayout>
    )
}

/** What an empty organization opens on: it says the organization is there and points at the one next step. */
const FirstProjectWelcome: React.FC<{ onCreateProject: () => void }> = ({ onCreateProject }) => {
    const { t } = useTranslation()
    const { organization } = useOrganizationStore()

    return (
        <AuthenticationLayout title={t("project.first_project.title")} description={t("project.first_project.description", { organization: organization?.name })}>
            <div className="flex flex-col items-center gap-4">
                <PartyPopper className="size-12 text-primary" aria-hidden />
                <p className="text-center text-sm text-muted-foreground">{t("project.first_project.hint")}</p>
                <Button className="w-full" onClick={onCreateProject} dataTestId="create-first-project">
                    {t("project.first_project.cta")}
                </Button>
            </div>
            <div className="mt-4 flex justify-center border-t border-divider pt-4">
                <SwitchOrganizationButton />
            </div>
        </AuthenticationLayout>
    )
}

const SelectProjectWrapperInner: React.FC<React.PropsWithChildren> = ({ children }) => {
    const projectStore = useProjectStore()
    const { organization } = useOrganizationStore()
    const queryClient = useQueryClient()
    const [firstRunComplete, setFirstRunComplete] = useState(false)
    const [isCreatingProject, setIsCreatingProject] = useState(false)
    // Same query key as the list below, so this reads the cached answer instead of fetching again.
    const invitationsQuery = usePendingInvitationsQuery()

    const hasProjects = Boolean(projectStore.projects && projectStore.projects.length > 0)
    const hasPendingInvitations = Boolean(invitationsQuery.data && invitationsQuery.data.length > 0)

    // Whether the user has somewhere to go depends on the invitations too, so hold on until they arrive.
    if (!hasProjects && invitationsQuery.isPending) {
        return (
            <div className="flex min-h-[200px] items-center justify-center">
                <Spinner />
            </div>
        )
    }

    // First run: no projects yet → a welcome screen that sends the user into the full project wizard.
    // Once there, `isCreatingProject` keeps the wizard mounted for every step even though
    // step 1 already sets the active project in the store.
    // A pending invitation is a way in as well, so it takes precedence over the welcome screen:
    // otherwise the only screen offered would be "create a project".
    // Only whoever administers the organization can open a project in it, so a plain member with
    // nothing shared with them yet is shown the picker's empty state instead of a wizard that would
    // fail on submit.
    const canCreateProjects = organization?.role === "OWNER" || organization?.role === "ADMIN"
    const isFirstRun = !hasProjects && !hasPendingInvitations && !firstRunComplete && canCreateProjects

    // The picker and the welcome screen both reach the wizard, which this component has to render itself:
    // until a project is active it shadows the routed pages, so navigating there would show nothing.
    if (isCreatingProject) {
        return (
            <NewProjectWizard
                mountPoint="/project-wizard"
                onComplete={() => {
                    setFirstRunComplete(true)
                    setIsCreatingProject(false)
                    queryClient.invalidateQueries({ queryKey: ["projects-mine"] })
                }}
            />
        )
    }

    if (isFirstRun) {
        return <FirstProjectWelcome onCreateProject={() => setIsCreatingProject(true)} />
    }

    if (projectStore.project) {
        return <>{children}</>
    }

    return <SelectProjectForm onCreateNewProject={canCreateProjects ? () => setIsCreatingProject(true) : undefined} />
}

const SelectProjectWrapper: React.FC<React.PropsWithChildren> = props => {
    const projectApi = useProjectApi()
    const projectStore = useProjectStore()

    const { organization } = useOrganizationStore()

    const projectsQuery = useQuery({
        // Keyed on the organization: switching tenant has to fetch its projects, not reuse the
        // previous answer.
        queryKey: ["projects-mine", organization?._id],
        queryFn: async () => {
            const organizationId = organization?._id
            try {
                const projects = await projectApi.getMineProjects(organizationId)

                // Invalidating "projects-mine" matches by prefix, so the query of the organization being
                // left behind is put back in flight as well. Its answer must no longer decide anything:
                // it would hand the app a project belonging to a tenant the user has already left, and
                // write it back over the one just chosen.
                if (organizationId !== useOrganizationStore.getState().organization?._id) {
                    return projects
                }

                projectStore.setProjects(projects)

                // What gets to survive a refetch, in order: the project already in use, then the one
                // remembered from a previous visit, and only then the single candidate there is nothing
                // to ask about. Read fresh, because a refetch runs long after this closure was built.
                const active = useProjectStore.getState().project
                const rememberedId = getProjectIdFromLocalStorage()
                const selected = projects.find(project => project._id === active?._id) ?? projects.find(project => project._id === rememberedId) ?? (projects.length === 1 ? projects[0] : undefined)

                // Anything that is not in this organization is dropped instead of carried over, which
                // leaves the picker to ask. Forgetting it too keeps the next visit from restoring it.
                projectStore.setProject(selected)
                if (selected) {
                    setProjectIdInLocalStorage(selected._id)
                } else {
                    clearProjectIdInLocalStorage()
                }

                return projects
            } catch (error) {
                console.error("Error fetching projects:", error)
                throw error
            }
        }
    })

    return (
        <ApiStatusHandler queries={[projectsQuery]}>
            <SelectProjectWrapperInner {...props} />
        </ApiStatusHandler>
    )
}

export default SelectProjectWrapper
