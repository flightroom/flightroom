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
import useCodeRepositoriesApi, { ICodeRepository } from "@/hooks/apiClients/useCodeRepositoriesApi"
import useDomainsApi from "@/hooks/apiClients/useDomainsApi"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import useMarketApi, { ServiceDefaults } from "@/hooks/apiClients/useMarketApi"
import { Resource, useResourceErrorMessage } from "@/hooks/apiClients/useResourcesApi"
import useServicesApi, { Service, ServiceDTO } from "@/hooks/apiClients/useServicesApi"
import type { VariableMap } from "@/hooks/apiClients/useVariableMapsApi"
import { CodeRepositorySection } from "@/pages/frontends/partials/components"
import { useResourcesQuery } from "@/pages/resources/partials/resources"
import { useVariableMapsQuery } from "@/pages/variable-maps/partials/variableMaps"
import useProjectStore from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import { isRecommendedTemplate, technologyOfMarket } from "@/utils/technologies"
import DomainSelectField from "../domains/partials/DomainSelectField"
import { CONTEXT_MAX_LENGTH } from "../settings/partials/ProjectContextSection"
import ServiceDangerZone from "./partials/ServiceDangerZone"
import ServiceEndpointFields from "./partials/ServiceEndpointFields"
import ServiceEnvFields from "./partials/ServiceEnvFields"
import ServiceHeader from "./partials/ServiceHeader"
import ServiceResourcesFields from "./partials/ServiceResourcesFields"
import ServiceRuntimeFields from "./partials/ServiceRuntimeFields"
import ServiceVariableMapsFields from "./partials/ServiceVariableMapsFields"
import { isServiceTemplate } from "./partials/serviceTemplates"
import { createServiceRuntimeShape, refineExposure, SERVICE_VERSION, useProjectEnvironmentsQuery } from "./partials/serviceVariables"

/** Same rule as the backend (SERVICE_SLUG): the slug names the workspace folder and the CI registration URL */
const SERVICE_SLUG = /^[a-z0-9][a-z0-9-]{1,49}$/

/** The fields a service template prefills */
const PREFILLED_FIELDS = ["port", "livenessPath", "readinessPath", "docsPath", "openApiPath"] as const
type PrefilledValues = Record<(typeof PREFILLED_FIELDS)[number], string>

const prefilledValuesOf = (defaults: ServiceDefaults): PrefilledValues => ({
    port: String(defaults.port),
    livenessPath: defaults.livenessPath,
    readinessPath: defaults.readinessPath,
    docsPath: defaults.docsPath ?? "",
    openApiPath: defaults.openApiPath ?? ""
})

interface FormMessages {
    slug: string
    version: string
    path: string
    exposurePath: string
    exposurePathRequired: string
}

const createFormSchema = (messages: FormMessages) =>
    z
        .object({
            slug: z.string().regex(SERVICE_SLUG, messages.slug),
            name: z.string().min(3).max(100),
            description: z.string().optional(),
            domainId: z.string().nullable().optional(),
            context: z.string().max(CONTEXT_MAX_LENGTH).optional(),
            template: z.string().optional(),
            // Blank: none yet, until the pipeline registers a first one
            version: z
                .string()
                .trim()
                .refine(value => value === "" || SERVICE_VERSION.test(value), messages.version)
                .optional(),
            ...createServiceRuntimeShape(messages),
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
        .superRefine((data, ctx) => refineExposure(data, ctx, messages))

type FormSchema = ReturnType<typeof createFormSchema>
type FormInput = z.input<FormSchema>
type FormValues = z.output<FormSchema>

/** Tabs that own validated fields, in the order they are shown: the first one with an error is the one we jump to. */
const FORM_TABS = ["general", "context", "runtime", "variables", "repository"] as const

type FormTab = (typeof FORM_TABS)[number] | "danger"

const isFormTab = (value: string | null): value is FormTab => Boolean(value && ([...FORM_TABS, "danger"] as string[]).includes(value))

const TAB_FIELDS: Record<FormTab, (keyof FormValues)[]> = {
    general: ["template", "name", "slug", "version", "description", "domainId"],
    context: ["context"],
    runtime: ["port", "image", "livenessPath", "readinessPath", "docsPath", "openApiPath", "exposed", "exposurePath"],
    variables: ["env", "configMapIds", "secretIds", "resourceIds"],
    repository: ["codeRepository"],
    danger: []
}

const ErrorDot: React.FC = () => <span className="ml-2 inline-block size-1.5 rounded-full bg-destructive align-middle" aria-hidden="true" />

interface AddServiceFormProps {
    repositories: ICodeRepository[]
    environments: EnvironmentDTO[]
    configMaps: VariableMap[]
    secrets: VariableMap[]
    resources: Resource[]
    service?: Service
}

const AddServiceForm: React.FC<AddServiceFormProps> = ({ repositories, environments, configMaps, secrets, resources, service }) => {
    const { t } = useTranslation()
    const { id } = useParams<{ id: string }>()
    const [searchParams] = useSearchParams()
    const location = useLocation()
    const isEdit = Boolean(id)
    const servicesApi = useServicesApi()
    const { errorMessage: domainErrorMessage } = useDomainsApi()
    // The refusals of the resources fall back to those of the maps
    const resourceErrorMessage = useResourceErrorMessage()
    const errorMessage = (error: Error) => resourceErrorMessage(error) ?? domainErrorMessage(error)
    const { getMarkets } = useMarketApi()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const notifications = useToastNotificationStore()
    const initialTemplate = searchParams.get("template") ?? undefined
    // Opened from a domain page: the service is created in it, and the page is where we go back
    const initialDomainId = searchParams.get("domainId")
    const hasRepositories = repositories.length > 0
    // `#runtime` (or the older `?tab=runtime`) opens a tab straight away.
    const hashTab = location.hash.slice(1)
    const linkedTab = isFormTab(hashTab) ? hashTab : searchParams.get("tab")
    const [activeTab, setActiveTab] = useState<FormTab>(isFormTab(linkedTab) ? linkedTab : "general")

    // The open tab is written in the hash, so a reload or a copied link lands on it
    const selectTab = (tab: FormTab) => {
        setActiveTab(tab)
        navigate({ search: location.search, hash: tab }, { replace: true })
    }

    const marketsQuery = useQuery({ queryKey: ["markets"], queryFn: getMarkets, enabled: !isEdit })
    const technologies = useProjectStore(state => state.project?.technologies)
    // The templates of the project's backend technology come first: the others stay in the list
    const serviceTemplates = useMemo(
        () => (marketsQuery.data ?? []).filter(isServiceTemplate).sort((a, b) => Number(isRecommendedTemplate(b, technologies)) - Number(isRecommendedTemplate(a, technologies))),
        [marketsQuery.data, technologies]
    )

    const formSchema = useMemo(
        () =>
            createFormSchema({
                slug: t("services.slug_invalid"),
                version: t("services.version_invalid"),
                path: t("services.path_invalid"),
                exposurePath: t("services.exposure_path_invalid"),
                exposurePathRequired: t("services.exposure_path_required")
            }),
        [t]
    )
    const form = useForm<FormInput, unknown, FormValues>({
        resolver: zodResolver(formSchema),
        defaultValues: service
            ? {
                  ...service,
                  version: service.version ?? "",
                  domainId: service.domainId ?? "",
                  port: String(service.port),
                  docsPath: service.docsPath ?? "",
                  openApiPath: service.openApiPath ?? "",
                  exposed: Boolean(service.exposurePath),
                  exposurePath: service.exposurePath ?? "",
                  env: service.env ?? [],
                  // Only the maps that still exist: one deleted meanwhile has no checkbox to untick, and would make every save fail
                  configMapIds: (service.configMapIds ?? []).filter(id => configMaps.some(map => map._id === id)),
                  secretIds: (service.secretIds ?? []).filter(id => secrets.some(map => map._id === id)),
                  resourceIds: (service.resourceIds ?? []).filter(id => resources.some(resource => resource._id === id))
              }
            : {
                  slug: "",
                  name: "",
                  description: "",
                  domainId: initialDomainId ?? "",
                  context: "",
                  template: initialTemplate,
                  version: "",
                  port: "8080",
                  livenessPath: "/health/live",
                  readinessPath: "/health/ready",
                  docsPath: "",
                  openApiPath: "",
                  // Off until asked for: a new service is reached from outside only when that is decided
                  exposed: false,
                  exposurePath: "",
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
        const defaults = serviceTemplates.find(market => market.slug === selectedTemplate)?.serviceDefaults
        if (isEdit || !defaults) return
        const next = prefilledValuesOf(defaults)
        for (const field of PREFILLED_FIELDS) {
            if (form.getValues(field) === prefilled.current[field]) {
                form.setValue(field, next[field], { shouldDirty: true })
            }
        }
        prefilled.current = next
    }, [selectedTemplate, serviceTemplates, isEdit, form])

    // Opened without ?template: start from the template of the project's backend technology, once, and leave it free to change or clear
    const preselected = useRef(false)
    useEffect(() => {
        if (isEdit || initialTemplate || preselected.current || !technologies) return
        const recommended = serviceTemplates.find(market => !market.comingSoon && isRecommendedTemplate(market, technologies))
        if (!recommended) return
        preselected.current = true
        if (!form.getValues("template")) form.setValue("template", recommended.slug)
    }, [serviceTemplates, technologies, isEdit, initialTemplate, form])

    const onSubmit = async (data: FormValues) => {
        // Blank: the service is in no domain
        const { exposed, ...fields } = data
        const dto = {
            ...fields,
            domainId: data.domainId || null,
            port: Number(data.port),
            // Null: not exposed on the host of the environments
            exposurePath: exposed ? data.exposurePath : null
        } as unknown as ServiceDTO
        const template = data.template || undefined
        // Sent only when typed here: saving the form must not move back a newer version the pipeline registered meanwhile
        if (!data.version || !form.formState.dirtyFields.version) delete dto.version

        if (!isEdit && template && dto.codeRepository) {
            dto.codeRepository.createData = { ...dto.codeRepository.createData, template, name: dto.codeRepository.createData?.name || data.slug }
        }

        if (isEdit) {
            await servicesApi.update(id!, dto, { customErrorMessage: errorMessage })
            notifications.showSuccessNotification({ message: t("services.updated_success_message") })
            await queryClient.invalidateQueries({ queryKey: ["service", id] })
            navigate(`/service/${id}`)
        } else {
            const created = await servicesApi.create(dto, { customErrorMessage: errorMessage })
            notifications.showSuccessNotification({ message: t("services.created_success_message") })
            navigate(initialDomainId ? `/domain/${initialDomainId}` : created?._id ? `/service/${created._id}` : "/services")
        }
        await queryClient.invalidateQueries({ queryKey: ["services"] })
    }

    // Another link followed while the page is open.
    useEffect(() => {
        if (isFormTab(linkedTab)) setActiveTab(linkedTab)
    }, [linkedTab])

    // A linked tab may not exist on this service (no repository, or not saved yet): fall back to the first one.
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
        if (firstTabWithErrors) selectTab(firstTabWithErrors)
    }

    const content = (
        <FormProvider {...form}>
            <form onSubmit={form.handleSubmit(onSubmit, onInvalid)} className="space-y-6">
                <Tabs value={shownTab} onValueChange={value => selectTab(value as FormTab)} tabsListPosition="fullWidth">
                    <TabsList>
                        <TabsTrigger value="general" className="flex-1">
                            {t("services.tabs.general")}
                            {tabHasErrors("general") && <ErrorDot />}
                        </TabsTrigger>
                        <TabsTrigger value="context" className="flex-1">
                            {t("services.tabs.context")}
                            {tabHasErrors("context") && <ErrorDot />}
                        </TabsTrigger>
                        <TabsTrigger value="runtime" className="flex-1">
                            {t("services.tabs.runtime")}
                            {tabHasErrors("runtime") && <ErrorDot />}
                        </TabsTrigger>
                        <TabsTrigger value="variables" className="flex-1">
                            {t("services.tabs.variables")}
                            {tabHasErrors("variables") && <ErrorDot />}
                        </TabsTrigger>
                        {hasRepositories && (
                            <TabsTrigger value="repository" className="flex-1">
                                {t("services.tabs.repository")}
                                {tabHasErrors("repository") && <ErrorDot />}
                            </TabsTrigger>
                        )}
                        {isEdit && (
                            <TabsTrigger value="danger" className="flex-1">
                                {t("services.tabs.danger_zone")}
                            </TabsTrigger>
                        )}
                    </TabsList>

                    {/* forceMount keeps every tab registered: switching tab must not drop the values or re-run the repository lookups. */}
                    <TabsContent value="general" forceMount>
                        <Card>
                            <CardHeader>
                                <CardTitle className="mb-0">{t("services.general_information")}</CardTitle>
                                <CardDescription>{t("services.general_information_description")}</CardDescription>
                            </CardHeader>
                            <CardContent className="flex flex-col gap-2 pt-3">
                                {!isEdit && (
                                    <SelectField
                                        name="template"
                                        label={t("services.template")}
                                        placeholder={t("services.template_placeholder")}
                                        options={serviceTemplates.map(market => {
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
                                        label={t("services.name")}
                                        placeholder={t("services.name_placeholder")}
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
                                    <TextField name="slug" disabled={isEdit} label={t("services.slug")} placeholder={t("services.slug_placeholder")} required containerClassName="flex-[1_1_240px]" />
                                </div>
                                <TextField name="version" label={t("services.version")} placeholder="1.0.0" description={t("services.version_hint")} />
                                <TextareaField name="description" label={t("services.description")} placeholder={t("services.description_placeholder")} />
                                <DomainSelectField containerClassName="w-full" />
                            </CardContent>
                        </Card>
                    </TabsContent>

                    <TabsContent value="context" forceMount>
                        <Card>
                            <CardHeader>
                                <CardTitle className="mb-0">{t("services.context.title")}</CardTitle>
                                <CardDescription>{t("services.context.subtitle")}</CardDescription>
                            </CardHeader>
                            <CardContent className="pt-3">
                                <TextareaField
                                    name="context"
                                    label={t("services.context.label")}
                                    placeholder={t("services.context.placeholder")}
                                    description={t("services.context.hint")}
                                    rows={12}
                                    className="font-mono text-sm"
                                    dataTestId="service-context"
                                />
                            </CardContent>
                        </Card>
                    </TabsContent>

                    <TabsContent value="runtime" forceMount>
                        <div className="flex flex-col gap-6">
                            <ServiceRuntimeFields />
                            <ServiceEndpointFields environments={environments} />
                        </div>
                    </TabsContent>

                    <TabsContent value="variables" forceMount>
                        <div className="flex flex-col gap-6">
                            <ServiceEnvFields />
                            <ServiceVariableMapsFields configMaps={configMaps} secrets={secrets} resources={resources} />
                            <ServiceResourcesFields resources={resources} />
                        </div>
                    </TabsContent>

                    {hasRepositories && (
                        <TabsContent value="repository" forceMount>
                            <CodeRepositorySection repositoriesData={repositories} isEdit={isEdit} forceCreation={!isEdit} />
                        </TabsContent>
                    )}

                    {isEdit && service && (
                        <TabsContent value="danger">
                            <ServiceDangerZone service={service} />
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

    if (isEdit && service) {
        return (
            <div className="flex min-h-full flex-col gap-6">
                <ServiceHeader service={service} active="settings" />
                {content}
            </div>
        )
    }

    return (
        <SinglePageLayout title={t("services.add_new")} description={t("services.add_new_description")}>
            {content}
        </SinglePageLayout>
    )
}

const AddServicePage: React.FC = () => {
    const { id } = useParams<{ id: string }>()
    const isEdit = Boolean(id)
    const servicesApi = useServicesApi()
    const codeRepositoriesApi = useCodeRepositoriesApi()
    const projectId = useProjectStore(state => state.project?._id)

    const repositoriesQuery = useQuery({
        queryKey: ["repositories", projectId],
        queryFn: () => codeRepositoriesApi.getRepositoriesByProjectId(projectId!),
        enabled: !!projectId
    })

    const serviceQuery = useQuery({
        queryKey: ["service", id],
        queryFn: () => servicesApi.getSingle(id!),
        enabled: isEdit
    })

    // The endpoint previews its URL in every environment
    const environmentsQuery = useProjectEnvironmentsQuery()
    const configMapsQuery = useVariableMapsQuery("configMap")
    const secretsQuery = useVariableMapsQuery("secret")
    const resourcesQuery = useResourcesQuery()

    return (
        <ApiStatusHandler queries={[repositoriesQuery, serviceQuery, environmentsQuery, configMapsQuery, secretsQuery, resourcesQuery]} interceptEmpty={false}>
            <AddServiceForm
                repositories={repositoriesQuery.data ?? []}
                environments={environmentsQuery.data ?? []}
                configMaps={configMapsQuery.data ?? []}
                secrets={secretsQuery.data ?? []}
                resources={resourcesQuery.data ?? []}
                service={serviceQuery.data}
            />
        </ApiStatusHandler>
    )
}

export default AddServicePage
