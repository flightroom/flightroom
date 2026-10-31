import { Card, CardContent, CardDescription, CardHeader, CardTitle, SelectField, StatusDot, Tabs, TabsContent, TabsList, TabsTrigger } from "@flightroom/design-system"
import { zodResolver } from "@hookform/resolvers/zod"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useRef, useState } from "react"
import { FieldErrors, FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import * as z from "zod"
import { Button } from "@/components/atoms"
import TextareaField from "@/components/input/TextareaField.rhf"
import TextField from "@/components/input/TextField.rhf"
import { ApiStatusHandler } from "@/components/organisms"
import SinglePageLayout from "@/components/SinglePageLayout"
import { technologyIconUrl } from "@/components/technology/technologyIcons"
import useBackendsApi, { Backend } from "@/hooks/apiClients/useBackendsApi"
import useCodeRepositoriesApi, { ICodeRepository } from "@/hooks/apiClients/useCodeRepositoriesApi"
import useDomainsApi from "@/hooks/apiClients/useDomainsApi"
import useFrontendsApi, { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import useMaintenanceAgentsApi, { MaintenanceAgent, MaintenanceAgentDTO, useMaintenanceErrorMessage } from "@/hooks/apiClients/useMaintenanceAgentsApi"
import useMarketApi from "@/hooks/apiClients/useMarketApi"
import { Resource, useResourceErrorMessage } from "@/hooks/apiClients/useResourcesApi"
import type { VariableMap } from "@/hooks/apiClients/useVariableMapsApi"
import { CodeRepositorySection } from "@/pages/frontends/partials/components"
import { useResourcesQuery } from "@/pages/resources/partials/resources"
import { useVariableMapsQuery } from "@/pages/variable-maps/partials/variableMaps"
import useProjectStore from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import { isRecommendedTemplate, technologyOfMarket } from "@/utils/technologies"
import BackendEnvFields from "../backends/partials/BackendEnvFields"
import BackendResourcesFields from "../backends/partials/BackendResourcesFields"
import BackendVariableMapsFields from "../backends/partials/BackendVariableMapsFields"
import { isBackendTemplate } from "../backends/partials/backendTemplates"
import { BACKEND_HTTP_PATH, BACKEND_VERSION } from "../backends/partials/backendVariables"
import { createResourceShape, type ResourceMessages, refineResources, resourceFormValues, resourceMessages } from "../backends/partials/containerResources"
import { createEnvironmentVersionsShape, environmentVersionFormValues } from "../backends/partials/environmentVersions"
import DomainSelectField from "../domains/partials/DomainSelectField"
import { CONTEXT_MAX_LENGTH } from "../settings/partials/ProjectContextSection"
import MaintenanceAgentHeader from "./partials/MaintenanceAgentHeader"
import MaintenanceDangerZone from "./partials/MaintenanceDangerZone"
import { MaintenanceKindField, MaintenanceRuntimeFields, MaintenanceScheduleFields, MaintenanceTargetPicker } from "./partials/MaintenanceFormFields"
import { isValidCron, isValidTimeZone, MAINTENANCE_LIST_PATH, MAINTENANCE_SLUG, maintenanceAgentPath, normalizeCron, SCHEDULE_PRESETS, type ScheduleMode, scheduleModeOf } from "./partials/maintenance"

/** The fields a backend template prefills: a maintenance agent is scaffolded from the same templates */
const PREFILLED_FIELDS = ["port", "livenessPath", "readinessPath"] as const
type PrefilledValues = Record<(typeof PREFILLED_FIELDS)[number], string>

interface FormMessages extends ResourceMessages {
    slug: string
    version: string
    path: string
    port: string
    cronRequired: string
    cronInvalid: string
    timeZone: string
}

const createFormSchema = (messages: FormMessages) =>
    z
        .object({
            slug: z.string().regex(MAINTENANCE_SLUG, messages.slug),
            name: z.string().min(3).max(100),
            description: z.string().optional(),
            domainId: z.string().nullable().optional(),
            context: z.string().max(CONTEXT_MAX_LENGTH).optional(),
            template: z.string().optional(),
            kind: z.enum(["container", "job"]),
            // Form only: which of the presets, or a cron typed by hand (checked below)
            scheduleMode: z.enum(["manual", "hourly", "daily", "weekly", "custom"]),
            schedule: z.string(),
            timeZone: z.string().trim(),
            // Blank: none yet, until the pipeline registers a first one
            version: z
                .string()
                .trim()
                .refine(value => value === "" || BACKEND_VERSION.test(value), messages.version)
                .optional(),
            // Blank: not deployed in that environment
            environmentVersions: createEnvironmentVersionsShape(messages.version),
            image: z.object({ repository: z.string().optional() }).optional(),
            // A container's only: a job has neither a port nor probes, so they are checked below
            port: z.string(),
            runPath: z.string().trim(),
            livenessPath: z.string().trim(),
            readinessPath: z.string().trim(),
            // A job's too: its CronJob runs the image with them
            ...createResourceShape(messages),
            env: z.array(
                z.object({
                    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
                    required: z.boolean().default(false),
                    secret: z.boolean().default(false),
                    description: z.string().optional()
                })
            ),
            configMapIds: z.array(z.string()),
            secretIds: z.array(z.string()),
            resourceIds: z.array(z.string()),
            backendIds: z.array(z.string()),
            frontendIds: z.array(z.string()),
            codeRepository: z
                .object({
                    enabled: z.boolean().default(false),
                    codeRepositoryId: z.string().optional(),
                    repositoryId: z.string().optional(),
                    name: z.string().optional(),
                    cloneUrlHttps: z.string().optional(),
                    cloneUrlSsh: z.string().optional(),
                    gitlab: z.object({ groupPath: z.string().optional(), groupId: z.number().optional() }).optional(),
                    createData: z.object({ name: z.string().min(3).max(100), private: z.boolean().default(false) }).optional()
                })
                .optional()
        })
        .superRefine((data, ctx) => {
            if (data.scheduleMode === "custom") {
                if (!data.schedule.trim()) ctx.addIssue({ code: "custom", message: messages.cronRequired, path: ["schedule"] })
                else if (!isValidCron(data.schedule)) ctx.addIssue({ code: "custom", message: messages.cronInvalid, path: ["schedule"] })
            }
            if (data.scheduleMode !== "manual" && data.timeZone && !isValidTimeZone(data.timeZone)) {
                ctx.addIssue({ code: "custom", message: messages.timeZone, path: ["timeZone"] })
            }
            refineResources(data, ctx, messages)
            if (data.kind !== "container") return
            if (!/^\d{1,5}$/.test(data.port)) ctx.addIssue({ code: "custom", message: messages.port, path: ["port"] })
            for (const field of ["runPath", "livenessPath", "readinessPath"] as const) {
                if (!BACKEND_HTTP_PATH.test(data[field])) ctx.addIssue({ code: "custom", message: messages.path, path: [field] })
            }
        })

type FormSchema = ReturnType<typeof createFormSchema>
type FormInput = z.input<FormSchema>
type FormValues = z.output<FormSchema>

/** Tabs that own validated fields, in the order they are shown: the first one with an error is the one we jump to. */
const FORM_TABS = ["general", "schedule", "runtime", "variables", "repository"] as const

type FormTab = (typeof FORM_TABS)[number] | "danger"

const isFormTab = (value: string | null): value is FormTab => Boolean(value && ([...FORM_TABS, "danger"] as string[]).includes(value))

const TAB_FIELDS: Record<FormTab, (keyof FormValues)[]> = {
    general: ["template", "name", "slug", "description", "domainId", "context", "kind"],
    schedule: ["scheduleMode", "schedule", "timeZone", "backendIds", "frontendIds"],
    runtime: [
        "port",
        "image",
        "version",
        "environmentVersions",
        "runPath",
        "livenessPath",
        "readinessPath",
        "cpuRequest",
        "cpuLimit",
        "memoryRequest",
        "memoryLimit",
        "replicas",
        "environmentResources"
    ],
    variables: ["env", "configMapIds", "secretIds", "resourceIds"],
    repository: ["codeRepository"],
    danger: []
}

const ErrorDot: React.FC = () => <StatusDot tone="destructive" size="sm" className="ml-2 align-middle" />

interface AddMaintenanceAgentFormProps {
    repositories: ICodeRepository[]
    configMaps: VariableMap[]
    secrets: VariableMap[]
    resources: Resource[]
    backends: Backend[]
    frontends: Frontend[]
    agent?: MaintenanceAgent
}

const AddMaintenanceAgentForm: React.FC<AddMaintenanceAgentFormProps> = ({ repositories, configMaps, secrets, resources, backends, frontends, agent }) => {
    const { t } = useTranslation()
    const { id } = useParams<{ id: string }>()
    const [searchParams] = useSearchParams()
    const isEdit = Boolean(id)
    const api = useMaintenanceAgentsApi()
    const maintenanceErrorMessage = useMaintenanceErrorMessage()
    const { errorMessage: domainErrorMessage } = useDomainsApi()
    const resourceErrorMessage = useResourceErrorMessage()
    const errorMessage = (error: Error) => maintenanceErrorMessage(error) ?? resourceErrorMessage(error) ?? domainErrorMessage(error)
    const { getMarkets } = useMarketApi()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const notifications = useToastNotificationStore()
    const hasRepositories = repositories.length > 0
    const linkedTab = searchParams.get("tab")
    const [activeTab, setActiveTab] = useState<FormTab>(isFormTab(linkedTab) ? linkedTab : "general")

    const marketsQuery = useQuery({ queryKey: ["markets"], queryFn: getMarkets, enabled: !isEdit })
    const technologies = useProjectStore(state => state.project?.technologies)
    // The templates of the project's backend technology come first: the others stay in the list
    const templates = useMemo(
        () => (marketsQuery.data ?? []).filter(isBackendTemplate).sort((a, b) => Number(isRecommendedTemplate(b, technologies)) - Number(isRecommendedTemplate(a, technologies))),
        [marketsQuery.data, technologies]
    )

    const formSchema = useMemo(
        () =>
            createFormSchema({
                slug: t("backends.slug_invalid"),
                version: t("backends.version_invalid"),
                path: t("backends.path_invalid"),
                port: t("maintenance.port_invalid"),
                cronRequired: t("maintenance.schedule.cron_required"),
                cronInvalid: t("maintenance.schedule.cron_invalid"),
                timeZone: t("maintenance.schedule.time_zone_invalid"),
                ...resourceMessages(t)
            }),
        [t]
    )
    const form = useForm<FormInput, unknown, FormValues>({
        resolver: zodResolver(formSchema),
        defaultValues: agent
            ? {
                  ...agent,
                  description: agent.description ?? "",
                  context: agent.context ?? "",
                  version: agent.version ?? "",
                  environmentVersions: environmentVersionFormValues(agent),
                  domainId: agent.domainId ?? "",
                  scheduleMode: scheduleModeOf(agent.schedule),
                  schedule: agent.schedule ?? "",
                  timeZone: agent.timeZone ?? "",
                  port: String(agent.port ?? 8080),
                  runPath: agent.runPath ?? "/run",
                  livenessPath: agent.livenessPath ?? "/health/live",
                  readinessPath: agent.readinessPath ?? "/health/ready",
                  image: { repository: agent.image?.repository ?? "" },
                  ...resourceFormValues(agent),
                  env: agent.env ?? [],
                  // Only what still exists: one deleted meanwhile has no row to remove, and would make every save fail
                  configMapIds: (agent.configMapIds ?? []).filter(mapId => configMaps.some(map => map._id === mapId)),
                  secretIds: (agent.secretIds ?? []).filter(mapId => secrets.some(map => map._id === mapId)),
                  resourceIds: (agent.resourceIds ?? []).filter(resourceId => resources.some(resource => resource._id === resourceId)),
                  backendIds: (agent.backendIds ?? []).filter(backendId => backends.some(backend => backend._id === backendId)),
                  frontendIds: (agent.frontendIds ?? []).filter(frontendId => frontends.some(frontend => frontend._id === frontendId))
              }
            : {
                  slug: "",
                  name: "",
                  description: "",
                  domainId: "",
                  context: "",
                  template: undefined,
                  kind: "job",
                  scheduleMode: "daily",
                  schedule: SCHEDULE_PRESETS.daily,
                  timeZone: "",
                  version: "",
                  environmentVersions: [],
                  port: "8080",
                  runPath: "/run",
                  livenessPath: "/health/live",
                  readinessPath: "/health/ready",
                  image: { repository: "" },
                  ...resourceFormValues(),
                  env: [],
                  configMapIds: [],
                  secretIds: [],
                  resourceIds: [],
                  backendIds: [],
                  frontendIds: [],
                  codeRepository: hasRepositories
                      ? {
                            enabled: false,
                            repositoryId: "create_new",
                            codeRepositoryId: repositories.length === 1 ? repositories[0]._id : repositories.find(repo => repo.default)?._id
                        }
                      : { enabled: false }
              }
    })

    // What the last template filled in: a field still holding it was not edited by hand, so the next template may replace it
    const prefilled = useRef<PrefilledValues>({ port: "8080", livenessPath: "/health/live", readinessPath: "/health/ready" })
    const selectedTemplate = form.watch("template")
    useEffect(() => {
        const defaults = templates.find(market => market.slug === selectedTemplate)?.backendDefaults
        if (isEdit || !defaults) return
        const next: PrefilledValues = { port: String(defaults.port), livenessPath: defaults.livenessPath, readinessPath: defaults.readinessPath }
        for (const field of PREFILLED_FIELDS) {
            if (form.getValues(field) === prefilled.current[field]) form.setValue(field, next[field], { shouldDirty: true })
        }
        prefilled.current = next
        // A template scaffolds a repository: it is created with the agent
        if (hasRepositories) form.setValue("codeRepository.enabled", true)
    }, [selectedTemplate, templates, isEdit, hasRepositories, form])

    const onSubmit = async (data: FormValues) => {
        const { scheduleMode, port, runPath, livenessPath, readinessPath, ...fields } = data
        const schedule = scheduleMode === "manual" ? null : scheduleMode === "custom" ? normalizeCron(data.schedule) : SCHEDULE_PRESETS[scheduleMode as Exclude<ScheduleMode, "manual" | "custom">]
        const dto = {
            ...fields,
            domainId: data.domainId || null,
            schedule,
            timeZone: schedule && data.timeZone ? data.timeZone : null,
            // A job has none of them: it runs and exits
            ...(data.kind === "container" ? { port: Number(port), runPath, livenessPath, readinessPath } : {})
        } as unknown as Partial<MaintenanceAgentDTO>
        const template = data.template || undefined
        // Sent only when typed here: saving the form must not move back a newer version the pipeline registered meanwhile
        if (!data.version || !form.formState.dirtyFields.version) delete dto.version
        if (isEdit) delete dto.slug

        if (!isEdit && template && dto.codeRepository) {
            dto.codeRepository.createData = { ...dto.codeRepository.createData, template, name: dto.codeRepository.createData?.name || data.slug }
        }

        if (isEdit) {
            await api.update(id!, dto, { customErrorMessage: errorMessage })
            notifications.showSuccessNotification({ message: t("maintenance.updated_success_message") })
            await queryClient.invalidateQueries({ queryKey: ["maintenance-agent", id] })
            navigate(maintenanceAgentPath(id!))
        } else {
            const created = await api.create(dto, { customErrorMessage: errorMessage })
            notifications.showSuccessNotification({ message: t("maintenance.created_success_message") })
            navigate(created?._id ? maintenanceAgentPath(created._id) : MAINTENANCE_LIST_PATH)
        }
        await queryClient.invalidateQueries({ queryKey: ["maintenance-agents"] })
    }

    // Another link followed while the page is open.
    useEffect(() => {
        if (isFormTab(linkedTab)) setActiveTab(linkedTab)
    }, [linkedTab])

    const isTabShown = (tab: FormTab) => {
        if (tab === "repository") return hasRepositories
        if (tab === "danger") return isEdit
        return true
    }
    const shownTab = isTabShown(activeTab) ? activeTab : "general"

    /** A tab is flagged when any of the fields it owns failed validation, so an error is never hidden behind an inactive tab. */
    const tabHasErrors = (tab: FormTab) => TAB_FIELDS[tab].some(field => Boolean(form.formState.errors[field]))

    const onInvalid = (errors: FieldErrors<FormInput>) => {
        const firstTabWithErrors = FORM_TABS.find(tab => isTabShown(tab) && TAB_FIELDS[tab].some(field => Boolean(errors[field])))
        if (firstTabWithErrors) setActiveTab(firstTabWithErrors)
    }

    const tabTrigger = (tab: FormTab) => (
        <TabsTrigger value={tab} className="flex-1">
            {t(`maintenance.tabs.${tab}`)}
            {tab !== "danger" && tabHasErrors(tab) && <ErrorDot />}
        </TabsTrigger>
    )

    const content = (
        <FormProvider {...form}>
            <form onSubmit={form.handleSubmit(onSubmit, onInvalid)} className="space-y-6">
                <Tabs value={shownTab} onValueChange={value => setActiveTab(value as FormTab)} tabsListPosition="fullWidth">
                    <TabsList>
                        {tabTrigger("general")}
                        {tabTrigger("schedule")}
                        {tabTrigger("runtime")}
                        {tabTrigger("variables")}
                        {hasRepositories && tabTrigger("repository")}
                        {isEdit && tabTrigger("danger")}
                    </TabsList>

                    {/* forceMount keeps every tab registered: switching tab must not drop the values or re-run the repository lookups. */}
                    <TabsContent value="general" forceMount>
                        <Card>
                            <CardHeader>
                                <CardTitle className="mb-0">{t("maintenance.general_information")}</CardTitle>
                                <CardDescription>{t("maintenance.general_information_description")}</CardDescription>
                            </CardHeader>
                            <CardContent className="flex flex-col gap-4 pt-3">
                                {!isEdit && (
                                    <SelectField
                                        name="template"
                                        label={t("maintenance.template")}
                                        placeholder={t("backends.template_placeholder")}
                                        description={t("maintenance.template_hint")}
                                        options={templates.map(market => {
                                            const technology = technologyOfMarket(market)
                                            const label = `${market.name} (${market.framework})`
                                            return {
                                                value: market.slug,
                                                label: isRecommendedTemplate(market, technologies) ? `${label} · ${t("technologies.recommended")}` : label,
                                                icon: technology ? technologyIconUrl(technology) : undefined
                                            }
                                        })}
                                        addClearButton
                                        clearLabel={t("technologies.clear_template")}
                                        className="w-full"
                                    />
                                )}
                                <div className="flex flex-wrap gap-x-4 gap-y-2">
                                    <TextField
                                        name="name"
                                        label={t("backends.name")}
                                        placeholder={t("maintenance.name_placeholder")}
                                        textTransform={value => value.replace("  ", " ")}
                                        required
                                        onChange={e => {
                                            const slug = e.target.value.toLowerCase().replace(/[^a-z0-9]/g, "-")
                                            if (!isEdit) {
                                                form.setValue("slug", slug)
                                                form.setValue("codeRepository.createData.name", slug)
                                            }
                                        }}
                                        containerClassName="flex-[1_1_240px]"
                                    />
                                    <TextField
                                        name="slug"
                                        disabled={isEdit}
                                        label={t("backends.slug")}
                                        placeholder={t("maintenance.slug_placeholder")}
                                        required
                                        containerClassName="flex-[1_1_240px]"
                                    />
                                </div>
                                <TextareaField name="description" label={t("backends.description")} placeholder={t("maintenance.description_placeholder")} />
                                <DomainSelectField containerClassName="w-full" />
                                <MaintenanceKindField />
                                <TextareaField
                                    name="context"
                                    maxLength={CONTEXT_MAX_LENGTH}
                                    label={t("backends.context.label")}
                                    placeholder={t("maintenance.context_placeholder")}
                                    description={t("backends.context.hint")}
                                    rows={6}
                                    className="font-mono text-sm"
                                />
                            </CardContent>
                        </Card>
                    </TabsContent>

                    <TabsContent value="schedule" forceMount>
                        <div className="flex flex-col gap-6">
                            <MaintenanceScheduleFields />
                            <Card>
                                <CardHeader>
                                    <CardTitle className="mb-0">{t("maintenance.targets.title")}</CardTitle>
                                    <CardDescription>{t("maintenance.targets.form_description")}</CardDescription>
                                </CardHeader>
                                <CardContent className="flex flex-wrap gap-4 pt-3">
                                    <MaintenanceTargetPicker name="backendIds" options={backends} title={t("maintenance.targets.backends")} dotClassName="bg-zomp-600 dark:bg-zomp-400" />
                                    <MaintenanceTargetPicker name="frontendIds" options={frontends} title={t("maintenance.targets.frontends")} dotClassName="bg-primary" />
                                </CardContent>
                            </Card>
                        </div>
                    </TabsContent>

                    <TabsContent value="runtime" forceMount>
                        <MaintenanceRuntimeFields />
                    </TabsContent>

                    <TabsContent value="variables" forceMount>
                        <div className="flex flex-col gap-6">
                            <BackendEnvFields />
                            <BackendVariableMapsFields configMaps={configMaps} secrets={secrets} resources={resources} />
                            <BackendResourcesFields resources={resources} />
                        </div>
                    </TabsContent>

                    {hasRepositories && (
                        <TabsContent value="repository" forceMount>
                            <CodeRepositorySection repositoriesData={repositories} isEdit={isEdit} forceCreation={!isEdit} />
                        </TabsContent>
                    )}

                    {isEdit && agent && (
                        <TabsContent value="danger">
                            <MaintenanceDangerZone agent={agent} />
                        </TabsContent>
                    )}
                </Tabs>

                <div className="flex justify-end gap-2">
                    <Button disabled={form.formState.isSubmitting} type="button" variant="secondary" onClick={() => navigate(-1)}>
                        {t("common.cancel")}
                    </Button>
                    <Button disabled={form.formState.isSubmitting} type="submit">
                        {t("common.save")}
                    </Button>
                </div>
            </form>
        </FormProvider>
    )

    if (isEdit && agent) {
        return (
            <div className="flex min-h-full flex-col gap-6">
                <MaintenanceAgentHeader agent={agent} active="settings" />
                {content}
            </div>
        )
    }

    return (
        <SinglePageLayout title={t("maintenance.add_new")} description={t("maintenance.add_new_description")}>
            {content}
        </SinglePageLayout>
    )
}

const AddMaintenanceAgent: React.FC = () => {
    const { id } = useParams<{ id: string }>()
    const isEdit = Boolean(id)
    const api = useMaintenanceAgentsApi()
    const codeRepositoriesApi = useCodeRepositoriesApi()
    const backendsApi = useBackendsApi()
    const frontendsApi = useFrontendsApi()
    const projectId = useProjectStore(state => state.project?._id)

    const repositoriesQuery = useQuery({
        queryKey: ["repositories", projectId],
        queryFn: () => codeRepositoriesApi.getRepositoriesByProjectId(projectId!),
        enabled: !!projectId
    })
    const agentQuery = useQuery({ queryKey: ["maintenance-agent", id], queryFn: () => api.getSingle(id!), enabled: isEdit })
    const backendsQuery = useQuery({ queryKey: ["backends", projectId], queryFn: backendsApi.getAll, enabled: !!projectId })
    const frontendsQuery = useQuery({ queryKey: ["frontends-by-project-id", projectId], queryFn: () => frontendsApi.getByProjectId(projectId), enabled: !!projectId })
    const configMapsQuery = useVariableMapsQuery("configMap")
    const secretsQuery = useVariableMapsQuery("secret")
    const resourcesQuery = useResourcesQuery()

    return (
        <ApiStatusHandler queries={[repositoriesQuery, agentQuery, backendsQuery, frontendsQuery, configMapsQuery, secretsQuery, resourcesQuery]} interceptEmpty={false}>
            <AddMaintenanceAgentForm
                repositories={repositoriesQuery.data ?? []}
                configMaps={configMapsQuery.data ?? []}
                secrets={secretsQuery.data ?? []}
                resources={resourcesQuery.data ?? []}
                backends={backendsQuery.data ?? []}
                frontends={frontendsQuery.data ?? []}
                agent={agentQuery.data}
            />
        </ApiStatusHandler>
    )
}

export default AddMaintenanceAgent
