import { Card, CardContent, CardDescription, CardHeader, CardTitle, SelectField, Tabs, TabsContent, TabsList, TabsTrigger } from "@flightroom/design-system"
import { zodResolver } from "@hookform/resolvers/zod"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useRef, useState } from "react"
import { FieldErrors, FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom"
import * as z from "zod"
import { Button } from "@/components/atoms"
import TextareaField from "@/components/input/TextareaField.rhf"
import TextField from "@/components/input/TextField.rhf"
import { ApiStatusHandler } from "@/components/organisms"
import SinglePageLayout from "@/components/SinglePageLayout"
import { technologyIconUrl } from "@/components/technology/technologyIcons"
import useBackendsApi, { Backend, BackendDTO } from "@/hooks/apiClients/useBackendsApi"
import useCodeRepositoriesApi, { ICodeRepository } from "@/hooks/apiClients/useCodeRepositoriesApi"
import useDomainsApi from "@/hooks/apiClients/useDomainsApi"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import useMarketApi, { BackendDefaults } from "@/hooks/apiClients/useMarketApi"
import { Resource, useResourceErrorMessage } from "@/hooks/apiClients/useResourcesApi"
import type { VariableMap } from "@/hooks/apiClients/useVariableMapsApi"
import { CodeRepositorySection, ReleaseSection } from "@/pages/frontends/partials/components"
import { useResourcesQuery } from "@/pages/resources/partials/resources"
import { useVariableMapsQuery } from "@/pages/variable-maps/partials/variableMaps"
import useProjectStore from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import { isRecommendedTemplate, technologyOfMarket } from "@/utils/technologies"
import DomainSection from "../domains/partials/DomainSection"
import { CONTEXT_MAX_LENGTH } from "../settings/partials/ProjectContextSection"
import BackendDangerZone from "./partials/BackendDangerZone"
import BackendEndpointFields from "./partials/BackendEndpointFields"
import BackendEnvFields from "./partials/BackendEnvFields"
import BackendHeader from "./partials/BackendHeader"
import BackendResourcesFields from "./partials/BackendResourcesFields"
import BackendRuntimeFields from "./partials/BackendRuntimeFields"
import BackendVariableMapsFields from "./partials/BackendVariableMapsFields"
import { isBackendTemplate } from "./partials/backendTemplates"
import { BACKEND_VERSION, createBackendRuntimeShape, refineExposure, useProjectEnvironmentsQuery } from "./partials/backendVariables"
import { type ResourceMessages, refineResources, resourceFormValues, resourceMessages } from "./partials/containerResources"
import { createEnvironmentVersionsShape, environmentVersionFormValues } from "./partials/environmentVersions"

/** Same rule as the backend (BACKEND_SLUG): the slug names the workspace folder and the CI registration URL */
const BACKEND_SLUG = /^[a-z0-9][a-z0-9-]{1,49}$/

/** The fields a backend template prefills */
const PREFILLED_FIELDS = ["port", "livenessPath", "readinessPath", "docsPath", "openApiPath"] as const
type PrefilledValues = Record<(typeof PREFILLED_FIELDS)[number], string>

const prefilledValuesOf = (defaults: BackendDefaults): PrefilledValues => ({
    port: String(defaults.port),
    livenessPath: defaults.livenessPath,
    readinessPath: defaults.readinessPath,
    docsPath: defaults.docsPath ?? "",
    openApiPath: defaults.openApiPath ?? ""
})

interface FormMessages extends ResourceMessages {
    slug: string
    version: string
    path: string
    exposurePath: string
    exposurePathRequired: string
}

const createFormSchema = (messages: FormMessages) =>
    z
        .object({
            slug: z.string().regex(BACKEND_SLUG, messages.slug),
            name: z.string().min(3).max(100),
            description: z.string().optional(),
            domainId: z.string().nullable().optional(),
            context: z.string().max(CONTEXT_MAX_LENGTH).optional(),
            template: z.string().optional(),
            // Blank: none yet, until the pipeline registers a first one
            version: z
                .string()
                .trim()
                .refine(value => value === "" || BACKEND_VERSION.test(value), messages.version)
                .optional(),
            // Blank: the version above
            environmentVersions: createEnvironmentVersionsShape(messages.version),
            ...createBackendRuntimeShape(messages),
            // Here and not in the runtime shape, which frontends share: a frontend never attaches a resource
            resourceIds: z.array(z.string()),
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
            refineExposure(data, ctx, messages)
            refineResources(data, ctx, messages)
        })

type FormSchema = ReturnType<typeof createFormSchema>
type FormInput = z.input<FormSchema>
type FormValues = z.output<FormSchema>

/** Tabs that own validated fields, in the order they are shown: the first one with an error is the one we jump to. */
const FORM_TABS = ["general", "context", "runtime"] as const

type FormTab = (typeof FORM_TABS)[number] | "danger"

const isFormTab = (value: string | null): value is FormTab => Boolean(value && ([...FORM_TABS, "danger"] as string[]).includes(value))

const TAB_FIELDS: Record<FormTab, (keyof FormValues)[]> = {
    general: ["template", "name", "slug", "version", "environmentVersions", "description", "domainId", "codeRepository"],
    context: ["context"],
    runtime: [
        "port",
        "image",
        "livenessPath",
        "readinessPath",
        "docsPath",
        "openApiPath",
        "cpuRequest",
        "cpuLimit",
        "memoryRequest",
        "memoryLimit",
        "environmentResources",
        "exposed",
        "exposurePath",
        "env",
        "configMapIds",
        "secretIds",
        "resourceIds"
    ],
    danger: []
}

const ErrorDot: React.FC = () => <span className="ml-2 inline-block size-1.5 rounded-full bg-destructive align-middle" aria-hidden="true" />

interface AddBackendFormProps {
    repositories: ICodeRepository[]
    environments: EnvironmentDTO[]
    configMaps: VariableMap[]
    secrets: VariableMap[]
    resources: Resource[]
    backend?: Backend
}

const AddBackendForm: React.FC<AddBackendFormProps> = ({ repositories, environments, configMaps, secrets, resources, backend }) => {
    const { t } = useTranslation()
    const { id } = useParams<{ id: string }>()
    const [searchParams] = useSearchParams()
    const location = useLocation()
    const isEdit = Boolean(id)
    const backendsApi = useBackendsApi()
    const { errorMessage: domainErrorMessage } = useDomainsApi()
    // The refusals of the resources fall back to those of the maps
    const resourceErrorMessage = useResourceErrorMessage()
    const errorMessage = (error: Error) => resourceErrorMessage(error) ?? domainErrorMessage(error)
    const { getMarkets } = useMarketApi()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const notifications = useToastNotificationStore()
    const initialTemplate = searchParams.get("template") ?? undefined
    // Opened from a domain page: the backend is created in it, and the page is where we go back
    const initialDomainId = searchParams.get("domainId")
    const hasRepositories = repositories.length > 0
    // `#runtime` opens a tab straight away.
    const linkedTab = location.hash.slice(1)
    const [activeTab, setActiveTab] = useState<FormTab>(isFormTab(linkedTab) ? linkedTab : "general")

    // The open tab is written in the hash, so a reload or a copied link lands on it
    const selectTab = (tab: FormTab) => {
        setActiveTab(tab)
        navigate({ search: location.search, hash: tab }, { replace: true })
    }

    const marketsQuery = useQuery({ queryKey: ["markets"], queryFn: getMarkets, enabled: !isEdit })
    const technologies = useProjectStore(state => state.project?.technologies)
    // The templates of the project's backend technology come first: the others stay in the list
    const backendTemplates = useMemo(
        () => (marketsQuery.data ?? []).filter(isBackendTemplate).sort((a, b) => Number(isRecommendedTemplate(b, technologies)) - Number(isRecommendedTemplate(a, technologies))),
        [marketsQuery.data, technologies]
    )

    const formSchema = useMemo(
        () =>
            createFormSchema({
                slug: t("backends.slug_invalid"),
                version: t("backends.version_invalid"),
                path: t("backends.path_invalid"),
                exposurePath: t("backends.exposure_path_invalid"),
                exposurePathRequired: t("backends.exposure_path_required"),
                ...resourceMessages(t)
            }),
        [t]
    )
    const form = useForm<FormInput, unknown, FormValues>({
        resolver: zodResolver(formSchema),
        defaultValues: backend
            ? {
                  ...backend,
                  version: backend.version ?? "",
                  environmentVersions: environmentVersionFormValues(backend),
                  domainId: backend.domainId ?? "",
                  port: String(backend.port),
                  docsPath: backend.docsPath ?? "",
                  openApiPath: backend.openApiPath ?? "",
                  exposed: Boolean(backend.exposurePath),
                  exposurePath: backend.exposurePath ?? "",
                  ...resourceFormValues(backend),
                  env: backend.env ?? [],
                  // Only the maps that still exist: one deleted meanwhile has no checkbox to untick, and would make every save fail
                  configMapIds: (backend.configMapIds ?? []).filter(id => configMaps.some(map => map._id === id)),
                  secretIds: (backend.secretIds ?? []).filter(id => secrets.some(map => map._id === id)),
                  resourceIds: (backend.resourceIds ?? []).filter(id => resources.some(resource => resource._id === id))
              }
            : {
                  slug: "",
                  name: "",
                  description: "",
                  domainId: initialDomainId ?? "",
                  context: "",
                  template: initialTemplate,
                  version: "",
                  environmentVersions: [],
                  port: "8080",
                  livenessPath: "/health/live",
                  readinessPath: "/health/ready",
                  docsPath: "",
                  openApiPath: "",
                  // Off until asked for: a new backend is reached from outside only when that is decided
                  exposed: false,
                  exposurePath: "",
                  ...resourceFormValues(),
                  image: { repository: "" },
                  env: [],
                  configMapIds: [],
                  secretIds: [],
                  resourceIds: [],
                  codeRepository: hasRepositories
                      ? {
                            enabled: Boolean(initialTemplate),
                            repositoryId: "create_new",
                            codeRepositoryId: repositories.length === 1 ? repositories[0]._id : repositories.find(repo => repo.default)?._id
                        }
                      : { enabled: false }
              }
    })

    // What the last template filled in: a field still holding it was not edited by hand, so the next template may replace it
    const prefilled = useRef<PrefilledValues>({ port: "8080", livenessPath: "/health/live", readinessPath: "/health/ready", docsPath: "", openApiPath: "" })
    const selectedTemplate = form.watch("template")
    useEffect(() => {
        const defaults = backendTemplates.find(market => market.slug === selectedTemplate)?.backendDefaults
        if (isEdit || !defaults) return
        const next = prefilledValuesOf(defaults)
        for (const field of PREFILLED_FIELDS) {
            if (form.getValues(field) === prefilled.current[field]) {
                form.setValue(field, next[field], { shouldDirty: true })
            }
        }
        prefilled.current = next
    }, [selectedTemplate, backendTemplates, isEdit, form])

    // Opened without ?template: start from the template of the project's backend technology, once, and leave it free to change or clear
    const preselected = useRef(false)
    useEffect(() => {
        if (isEdit || initialTemplate || preselected.current || !technologies) return
        const recommended = backendTemplates.find(market => !market.comingSoon && isRecommendedTemplate(market, technologies))
        if (!recommended) return
        preselected.current = true
        if (!form.getValues("template")) form.setValue("template", recommended.slug)
    }, [backendTemplates, technologies, isEdit, initialTemplate, form])

    const onSubmit = async (data: FormValues) => {
        // Blank: the backend is in no domain
        const { exposed, ...fields } = data
        const dto = {
            ...fields,
            domainId: data.domainId || null,
            port: Number(data.port),
            // Null: not exposed on the host of the environments
            exposurePath: exposed ? data.exposurePath : null
        } as unknown as BackendDTO
        const template = data.template || undefined
        // Sent only when typed here: saving the form must not move back a newer version the pipeline registered meanwhile
        if (!data.version || !form.formState.dirtyFields.version) delete dto.version

        if (!isEdit && template && dto.codeRepository) {
            dto.codeRepository.createData = { ...dto.codeRepository.createData, template, name: dto.codeRepository.createData?.name || data.slug }
        }

        if (isEdit) {
            await backendsApi.update(id!, dto, { customErrorMessage: errorMessage })
            notifications.showSuccessNotification({ message: t("backends.updated_success_message") })
            await queryClient.invalidateQueries({ queryKey: ["backend", id] })
            navigate(`/backend/${id}`)
        } else {
            const created = await backendsApi.create(dto, { customErrorMessage: errorMessage })
            notifications.showSuccessNotification({ message: t("backends.created_success_message") })
            navigate(initialDomainId ? `/domain/${initialDomainId}` : created?._id ? `/backend/${created._id}` : "/backends")
        }
        await queryClient.invalidateQueries({ queryKey: ["backends"] })
    }

    // Another link followed while the page is open.
    useEffect(() => {
        if (isFormTab(linkedTab)) setActiveTab(linkedTab)
    }, [linkedTab])

    // A linked tab may not exist on this backend (not saved yet): fall back to the first one.
    const isTabShown = (tab: FormTab) => {
        if (tab === "danger") return isEdit
        return true
    }
    const shownTab = isTabShown(activeTab) ? activeTab : "general"

    /** A tab is flagged when any of the fields it owns failed validation, so an error is never hidden behind an inactive tab. */
    const tabHasErrors = (tab: FormTab) => TAB_FIELDS[tab].some(field => Boolean(form.formState.errors[field]))

    const onInvalid = (errors: FieldErrors<FormInput>) => {
        const firstTabWithErrors = FORM_TABS.find(tab => isTabShown(tab) && TAB_FIELDS[tab].some(field => Boolean(errors[field])))
        if (firstTabWithErrors) selectTab(firstTabWithErrors)
    }

    const content = (
        <FormProvider {...form}>
            <form onSubmit={form.handleSubmit(onSubmit, onInvalid)} className="space-y-6">
                <Tabs value={shownTab} onValueChange={value => selectTab(value as FormTab)} tabsListPosition="fullWidth">
                    <TabsList>
                        <TabsTrigger value="general" className="flex-1">
                            {t("backends.tabs.general")}
                            {tabHasErrors("general") && <ErrorDot />}
                        </TabsTrigger>
                        <TabsTrigger value="context" className="flex-1">
                            {t("backends.tabs.context")}
                            {tabHasErrors("context") && <ErrorDot />}
                        </TabsTrigger>
                        <TabsTrigger value="runtime" className="flex-1">
                            {t("backends.tabs.runtime")}
                            {tabHasErrors("runtime") && <ErrorDot />}
                        </TabsTrigger>
                        {isEdit && (
                            <TabsTrigger value="danger" className="flex-1">
                                {t("backends.tabs.danger_zone")}
                            </TabsTrigger>
                        )}
                    </TabsList>

                    {/* forceMount keeps every tab registered: switching tab must not drop the values or re-run the repository lookups. */}
                    <TabsContent value="general" forceMount>
                        <div className="flex flex-col gap-6">
                            {/* Domain and release first, side by side: what it belongs to and what is served, at a glance */}
                            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                                <DomainSection />
                                {/* The same card as a DOCKER frontend's: the version is the tag of the image */}
                                <ReleaseSection container />
                            </div>
                            <Card>
                                <CardHeader>
                                    <CardTitle className="mb-0">{t("backends.general_information")}</CardTitle>
                                    <CardDescription>{t("backends.general_information_description")}</CardDescription>
                                </CardHeader>
                                <CardContent className="flex flex-col gap-2 pt-3">
                                    {!isEdit && (
                                        <SelectField
                                            name="template"
                                            label={t("backends.template")}
                                            placeholder={t("backends.template_placeholder")}
                                            options={backendTemplates.map(market => {
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
                                            placeholder={t("backends.name_placeholder")}
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
                                            placeholder={t("backends.slug_placeholder")}
                                            required
                                            containerClassName="flex-[1_1_240px]"
                                        />
                                    </div>
                                    <TextareaField name="description" label={t("backends.description")} placeholder={t("backends.description_placeholder")} />
                                </CardContent>
                            </Card>
                            {hasRepositories && <CodeRepositorySection repositoriesData={repositories} isEdit={isEdit} forceCreation={!isEdit} />}
                        </div>
                    </TabsContent>

                    <TabsContent value="context" forceMount>
                        <Card>
                            <CardHeader>
                                <CardTitle className="mb-0">{t("backends.context.title")}</CardTitle>
                                <CardDescription>{t("backends.context.subtitle")}</CardDescription>
                            </CardHeader>
                            <CardContent className="pt-3">
                                <TextareaField
                                    name="context"
                                    maxLength={CONTEXT_MAX_LENGTH}
                                    label={t("backends.context.label")}
                                    placeholder={t("backends.context.placeholder")}
                                    description={t("backends.context.hint")}
                                    rows={12}
                                    className="font-mono text-sm"
                                    dataTestId="backend-context"
                                />
                            </CardContent>
                        </Card>
                    </TabsContent>

                    <TabsContent value="runtime" forceMount>
                        <div className="flex flex-col gap-6">
                            <BackendRuntimeFields />
                            <BackendEndpointFields environments={environments} />
                            <BackendEnvFields />
                            <BackendVariableMapsFields configMaps={configMaps} secrets={secrets} resources={resources} />
                            <BackendResourcesFields resources={resources} />
                        </div>
                    </TabsContent>

                    {isEdit && backend && (
                        <TabsContent value="danger">
                            <BackendDangerZone backend={backend} />
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

    if (isEdit && backend) {
        return (
            <div className="flex min-h-full flex-col gap-6">
                <BackendHeader backend={backend} active="settings" />
                {content}
            </div>
        )
    }

    return (
        <SinglePageLayout title={t("backends.add_new")} description={t("backends.add_new_description")}>
            {content}
        </SinglePageLayout>
    )
}

const AddBackendPage: React.FC = () => {
    const { id } = useParams<{ id: string }>()
    const isEdit = Boolean(id)
    const backendsApi = useBackendsApi()
    const codeRepositoriesApi = useCodeRepositoriesApi()
    const projectId = useProjectStore(state => state.project?._id)

    const repositoriesQuery = useQuery({
        queryKey: ["repositories", projectId],
        queryFn: () => codeRepositoriesApi.getRepositoriesByProjectId(projectId!),
        enabled: !!projectId
    })

    const backendQuery = useQuery({
        queryKey: ["backend", id],
        queryFn: () => backendsApi.getSingle(id!),
        enabled: isEdit
    })

    // The endpoint previews its URL in every environment
    const environmentsQuery = useProjectEnvironmentsQuery()
    const configMapsQuery = useVariableMapsQuery("configMap")
    const secretsQuery = useVariableMapsQuery("secret")
    const resourcesQuery = useResourcesQuery()

    return (
        <ApiStatusHandler queries={[repositoriesQuery, backendQuery, environmentsQuery, configMapsQuery, secretsQuery, resourcesQuery]} interceptEmpty={false}>
            <AddBackendForm
                repositories={repositoriesQuery.data ?? []}
                environments={environmentsQuery.data ?? []}
                configMaps={configMapsQuery.data ?? []}
                secrets={secretsQuery.data ?? []}
                resources={resourcesQuery.data ?? []}
                backend={backendQuery.data}
            />
        </ApiStatusHandler>
    )
}

export default AddBackendPage
