import { Tabs, TabsContent, TabsList, TabsTrigger } from "@flightroom/design-system"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot, Database, FolderCog, GitBranch, HardDrive, Key, Rocket, Server, Settings2, Users } from "lucide-react"
import React from "react"
import { useTranslation } from "react-i18next"
import { useNavigate, useSearchParams } from "react-router-dom"
// Components
import AiUsageSummary from "@/components/ai-usage/AiUsageSummary"
import { ApiStatusHandler } from "@/components/organisms"
import SinglePageLayout from "@/components/SinglePageLayout"
import useGitOpsErrorMessage from "@/hooks/apiClients/useGitOpsErrorMessage"
// Hooks & Stores
import useProjectApi from "@/hooks/apiClients/useProjectApi"
import useProjectStore from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import {
    ArgoCdSection,
    DangerZone,
    GitOpsSection,
    PipelineTemplatesSection,
    ProjectContainerRegistrySection,
    ProjectContextSection,
    ProjectDesignSystemSection,
    ProjectExposureSection,
    ProjectInfoSection,
    ProjectStatsSection,
    ProjectTechnologiesSection,
    toDesignSystem
} from "./partials"
import type { DesignSystemFormValues } from "./partials/DesignSystemFields"
import type { GitOpsFormValues } from "./partials/GitOpsSection"
import type { PipelineTemplatesFormValues } from "./partials/PipelineTemplatesSection"
import type { ProjectContainerRegistryFormValues } from "./partials/ProjectContainerRegistrySection"
import type { ProjectContextFormValues } from "./partials/ProjectContextSection"
import type { ProjectExposureFormValues } from "./partials/ProjectExposureSection"
import type { ProjectInfoFormValues } from "./partials/ProjectInfoSection"
import type { ProjectTechnologiesFormValues } from "./partials/ProjectTechnologiesSection"

const TABS = ["general", "access", "resources", "delivery"] as const
type Tab = (typeof TABS)[number]

const TAB_ICONS: Record<Tab, React.ComponentType> = { general: Settings2, access: Users, resources: FolderCog, delivery: Rocket }

/**
 * Le impostazioni del progetto, un tema per scheda: i dati e il contesto AI, chi vi accede, le sue risorse, come arriva
 * nei cluster. La scheda sta nell'URL (`?tab=delivery`) cosi' un link puo' puntare dritto a una di esse.
 */
export const Settings: React.FC = () => {
    const notifications = useToastNotificationStore()
    const { t } = useTranslation()
    const { project, setProject } = useProjectStore()
    const projectApi = useProjectApi()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const gitOpsErrorMessage = useGitOpsErrorMessage()
    const [searchParams, setSearchParams] = useSearchParams()

    const requestedTab = searchParams.get("tab")
    const tab: Tab = TABS.includes(requestedTab as Tab) ? (requestedTab as Tab) : "general"

    const projectQuery = useQuery({
        queryKey: ["project-summary", project._id],
        queryFn: () => projectApi.getProjectSummaryById(project._id),
        enabled: !!project._id
    })

    const handleDeleteProjectSuccess = async () => {
        notifications.showSuccessNotification({ message: t("settings.notifications.projectDeleted") })
        // Chiave del listato dei progetti: senza prefisso corretto lo switcher continuerebbe a
        // mostrare il progetto appena eliminato.
        queryClient.invalidateQueries({ queryKey: ["projects-mine"] })
        setProject(null)
        navigate("/")
    }

    const updateProjectMutation = useMutation({
        mutationFn: (values: ProjectInfoFormValues) =>
            projectApi.updateProject(project._id, {
                name: values.name.trim(),
                // Un campo svuotato vuol dire "nessuna descrizione", che l'API esprime con un null esplicito.
                description: values.description?.trim() ? values.description : null
            }),
        onSuccess: updated => {
            // Header e switcher leggono lo store, quindi il nuovo nome deve arrivare anche lì.
            setProject({ ...project, name: updated.name, description: updated.description })
            queryClient.invalidateQueries({ queryKey: ["project-summary", project._id] })
            queryClient.invalidateQueries({ queryKey: ["projects-mine"] })
            notifications.showSuccessNotification({ message: t("settings.notifications.projectUpdated") })
        },
        onError: () => {
            notifications.showErrorNotification({ message: t("settings.notifications.projectUpdateFailed") })
        }
    })

    const updateContextMutation = useMutation({
        mutationFn: (values: ProjectContextFormValues) => projectApi.updateProject(project._id, { context: values.context.trim() ? values.context : null }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["project-summary", project._id] })
            notifications.showSuccessNotification({ message: t("settings.notifications.contextUpdated") })
        },
        onError: () => {
            notifications.showErrorNotification({ message: t("settings.notifications.contextUpdateFailed") })
        }
    })

    const updateTechnologiesMutation = useMutation({
        // Una tecnologia lasciata a "nessuna" va tolta, che l'API esprime con un null esplicito
        mutationFn: (values: ProjectTechnologiesFormValues) => projectApi.updateProject(project._id, { technologies: { frontend: values.frontend ?? null, backend: values.backend ?? null } }),
        onSuccess: updated => {
            // Template, servizi e header leggono le tecnologie dallo store
            setProject({ ...project, technologies: updated.technologies })
            queryClient.invalidateQueries({ queryKey: ["project-summary", project._id] })
            queryClient.invalidateQueries({ queryKey: ["projects-mine"] })
            notifications.showSuccessNotification({ message: t("technologies.settings.saved") })
        },
        onError: () => {
            notifications.showErrorNotification({ message: t("technologies.settings.save_failed") })
        }
    })

    const updateDesignSystemMutation = useMutation({
        // Senza pacchetto il design system va tolto, che l'API esprime con un null esplicito
        mutationFn: (values: DesignSystemFormValues) => projectApi.updateProject(project._id, { designSystem: toDesignSystem(values) }),
        onSuccess: updated => {
            // Il form dei frontend legge dallo store il design system che ereditano
            setProject({ ...project, designSystem: updated.designSystem })
            queryClient.invalidateQueries({ queryKey: ["project-summary", project._id] })
            queryClient.invalidateQueries({ queryKey: ["projects-mine"] })
            notifications.showSuccessNotification({ message: t("designSystem.settings.saved") })
        },
        onError: () => {
            notifications.showErrorNotification({ message: t("designSystem.settings.save_failed") })
        }
    })

    const updateExposureMutation = useMutation({
        mutationFn: (values: ProjectExposureFormValues) =>
            projectApi.updateProject(project._id, {
                // Un dominio svuotato vuol dire "non esposto", che l'API esprime con un null esplicito
                exposure: values.domain.trim()
                    ? { domain: values.domain.trim().toLowerCase(), certificateIssuer: values.certificateIssuer.trim() || null, httpPort: values.httpPort, httpsPort: values.httpsPort }
                    : null
            }),
        onSuccess: updated => {
            // Il dialog degli ambienti legge il dominio dallo store per mostrare l'host
            setProject({ ...project, exposure: updated.exposure })
            queryClient.invalidateQueries({ queryKey: ["project-summary", project._id] })
            notifications.showSuccessNotification({ message: t("settings.notifications.exposureUpdated") })
        },
        onError: () => {
            notifications.showErrorNotification({ message: t("settings.notifications.exposureUpdateFailed") })
        }
    })

    const updateContainerRegistryMutation = useMutation({
        // Un registry svuotato vuol dire "nessuno", che l'API esprime con un null esplicito
        mutationFn: (values: ProjectContainerRegistryFormValues) => projectApi.updateProject(project._id, { containerRegistry: values.containerRegistry.trim() || null }),
        onSuccess: updated => {
            // Il form dei servizi e dei frontend Docker legge il registry dallo store per mostrare l'immagine deployata
            setProject({ ...project, containerRegistry: updated.containerRegistry })
            queryClient.invalidateQueries({ queryKey: ["project-summary", project._id] })
            notifications.showSuccessNotification({ message: t("settings.notifications.containerRegistryUpdated") })
        },
        onError: () => {
            notifications.showErrorNotification({ message: t("settings.notifications.containerRegistryUpdateFailed") })
        }
    })

    const updateGitOpsMutation = useMutation({
        mutationFn: (values: GitOpsFormValues) => projectApi.updateProject(project._id, { gitOps: values }, gitOpsErrorMessage),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["project-summary", project._id] })
            // Un repository appena creato deve comparire nell'elenco
            queryClient.invalidateQueries({ queryKey: ["importable-repositories"] })
            notifications.showSuccessNotification({ message: t("settings.gitOps.saved") })
        }
    })

    const updatePipelinesMutation = useMutation({
        mutationFn: (values: PipelineTemplatesFormValues) => projectApi.updateProject(project._id, { pipelines: values }, gitOpsErrorMessage),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["project-summary", project._id] })
            notifications.showSuccessNotification({ message: t("settings.pipelines.saved") })
        }
    })

    const projectData = projectQuery.data?.project

    return (
        <ApiStatusHandler queries={[projectQuery]}>
            <SinglePageLayout title={t("settings.title")} description={t("settings.subtitle")}>
                <Tabs value={tab} onValueChange={value => setSearchParams({ tab: value }, { replace: true })}>
                    <TabsList aria-label={t("settings.tabs.label")}>
                        {TABS.map(value => {
                            const Icon = TAB_ICONS[value]
                            return (
                                <TabsTrigger key={value} value={value} dataTestId={`settings-tab-${value}`}>
                                    <Icon />
                                    {t(`settings.tabs.${value}`)}
                                </TabsTrigger>
                            )
                        })}
                    </TabsList>

                    <TabsContent value="general" className="mt-6 flex flex-col gap-6">
                        {projectData && <ProjectInfoSection {...projectData} onUpdate={values => updateProjectMutation.mutate(values)} isUpdating={updateProjectMutation.isPending} />}

                        {projectData && (
                            <ProjectTechnologiesSection
                                key={projectData._id}
                                technologies={projectData.technologies}
                                onUpdate={values => updateTechnologiesMutation.mutate(values)}
                                isUpdating={updateTechnologiesMutation.isPending}
                            />
                        )}

                        {projectData && (
                            <ProjectDesignSystemSection
                                key={`design-system-${projectData._id}`}
                                designSystem={projectData.designSystem}
                                onUpdate={values => updateDesignSystemMutation.mutate(values)}
                                isUpdating={updateDesignSystemMutation.isPending}
                            />
                        )}

                        {projectData && <ProjectContextSection context={projectData.context} onUpdate={values => updateContextMutation.mutate(values)} isUpdating={updateContextMutation.isPending} />}

                        <DangerZone projectName={projectData?.name} projectId={projectData?._id} onDeleteSuccess={handleDeleteProjectSuccess} />
                    </TabsContent>

                    <TabsContent value="access" className="mt-6">
                        <ProjectStatsSection
                            title={t("settings.stats.accessTitle")}
                            stats={[
                                {
                                    icon: <Users />,
                                    title: t("settings.stats.teamMembers"),
                                    value: projectQuery.data?.count?.users,
                                    href: "/project-users"
                                },
                                {
                                    icon: <Key />,
                                    title: t("settings.stats.apiKeys"),
                                    value: projectQuery.data?.count?.apiKeys,
                                    href: "/api-keys"
                                },
                                {
                                    icon: <Bot />,
                                    title: t("settings.stats.mcpClients"),
                                    value: "—",
                                    buttonText: t("settings.stats.manage"),
                                    href: "/mcp-clients"
                                }
                            ]}
                        />
                    </TabsContent>

                    <TabsContent value="resources" className="mt-6 flex flex-col gap-6">
                        <ProjectStatsSection
                            title={t("settings.stats.resourcesTitle")}
                            stats={[
                                {
                                    icon: <Server />,
                                    title: t("settings.stats.environments"),
                                    value: projectQuery.data?.count?.environments,
                                    href: "/environments"
                                },
                                {
                                    icon: <GitBranch />,
                                    title: t("settings.stats.codeRepositories"),
                                    value: projectQuery.data?.count?.codeRepositories,
                                    href: "/code-repositories"
                                },
                                {
                                    icon: <HardDrive />,
                                    title: t("settings.stats.storages"),
                                    value: projectQuery.data?.count?.storages,
                                    href: "/storages"
                                },
                                {
                                    icon: <Database />,
                                    title: t("settings.stats.databases"),
                                    value: projectQuery.data?.count?.databases,
                                    href: "/databases"
                                }
                            ]}
                        />
                        {/* I token spesi da Modifica con AI e da Maestro: una risorsa del progetto come le altre di questa scheda. Non per chi vede solo alcuni domini: il totale e' di tutto il progetto, il server lo rifiuta */}
                        {project._id && !project.domainScoped && <AiUsageSummary target={{ kind: "project", id: project._id }} />}
                    </TabsContent>

                    {/* Nell'ordine in cui si configurano: Exposure e Argo CD lavorano su cio' che GitOps committa */}
                    <TabsContent value="delivery" className="mt-6 flex flex-col gap-6">
                        {projectData && (
                            <GitOpsSection
                                projectId={projectData._id}
                                projectSlug={projectData.slug}
                                gitOps={projectData.gitOps}
                                onUpdate={values => updateGitOpsMutation.mutate(values)}
                                isUpdating={updateGitOpsMutation.isPending}
                            />
                        )}

                        {projectData?.gitOps?.enabled && projectData.gitOps.codeRepository && (
                            <ProjectExposureSection exposure={projectData.exposure} onUpdate={values => updateExposureMutation.mutate(values)} isUpdating={updateExposureMutation.isPending} />
                        )}

                        {projectData?.gitOps?.enabled && projectData.gitOps.codeRepository && (
                            <ProjectContainerRegistrySection
                                containerRegistry={projectData.containerRegistry}
                                onUpdate={values => updateContainerRegistryMutation.mutate(values)}
                                isUpdating={updateContainerRegistryMutation.isPending}
                            />
                        )}

                        {/* Argo CD deploya cio che il GitOps salvato committa: senza repository di configurazione non c'e' niente da consegnargli */}
                        {projectData?.gitOps?.enabled && projectData.gitOps.codeRepository && <ArgoCdSection projectId={projectData._id} />}

                        {projectData && (
                            <PipelineTemplatesSection
                                projectId={projectData._id}
                                pipelines={projectData.pipelines}
                                onUpdate={values => updatePipelinesMutation.mutate(values)}
                                isUpdating={updatePipelinesMutation.isPending}
                            />
                        )}
                    </TabsContent>
                </Tabs>
            </SinglePageLayout>
        </ApiStatusHandler>
    )
}

export default Settings
