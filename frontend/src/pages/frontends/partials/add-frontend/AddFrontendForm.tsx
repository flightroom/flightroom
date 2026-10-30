import { Tabs, TabsContent, TabsList, TabsTrigger } from "@flightroom/design-system"
import { zodResolver } from "@hookform/resolvers/zod"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo } from "react"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom"
import useProjectAiModels from "@/components/assistant/useProjectAiModels"
import { Button } from "@/components/atoms"
import SinglePageLayout from "@/components/SinglePageLayout"
import type { ICodeRepository } from "@/hooks/apiClients/useCodeRepositoriesApi"
import useDomainsApi from "@/hooks/apiClients/useDomainsApi"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import useFrontendsApi, { type Frontend, FrontendKind } from "@/hooks/apiClients/useFrontendsApi"
import useMarketApi from "@/hooks/apiClients/useMarketApi"
import type { Storage } from "@/hooks/apiClients/useStorageApi"
import { useVariableMapErrorMessage, type VariableMap } from "@/hooks/apiClients/useVariableMapsApi"
import BackendEndpointFields from "@/pages/backends/partials/BackendEndpointFields"
import BackendEnvFields from "@/pages/backends/partials/BackendEnvFields"
import BackendRuntimeFields from "@/pages/backends/partials/BackendRuntimeFields"
import BackendVariableMapsFields from "@/pages/backends/partials/BackendVariableMapsFields"
import { resourceMessages } from "@/pages/backends/partials/containerResources"
import { DangerZoneRemoveFrontend, FrontendHeader, HostingSection, isAiEditAvailable } from "@/pages/frontends/partials/components"
import { FetchDataTemplateCard } from "@/pages/templates-library/partials/"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import { ContextTab } from "./ContextTab"
import { createFormSchema, type FormInput, type FormValues } from "./frontendFormSchema"
import { frontendFormDefaults, toFrontendPayload } from "./frontendFormValues"
import { GeneralTab } from "./GeneralTab"
import { type FormTab, useFrontendFormTabs } from "./useFrontendFormTabs"

const ErrorDot: React.FC = () => <span className="ml-2 inline-block size-1.5 rounded-full bg-destructive align-middle" aria-hidden="true" />

/** A tab of the form, with a dot when a field it owns failed validation */
const FormTabTrigger: React.FC<{ value: FormTab; label: string; hasErrors: boolean }> = ({ value, label, hasErrors }) => (
    <TabsTrigger value={value} className="flex-1">
        {label}
        {hasErrors && <ErrorDot />}
    </TabsTrigger>
)

interface AddFrontendFormProps {
    storages: Storage[]
    repositories: ICodeRepository[]
    frontend?: Frontend
    versions?: string[]
    environments: EnvironmentDTO[]
    configMaps: VariableMap[]
    secrets: VariableMap[]
}

export const AddFrontendForm: React.FC<AddFrontendFormProps> = ({ versions, repositories, frontend, storages, environments, configMaps, secrets }) => {
    const { t } = useTranslation()
    const { id } = useParams<{ id: string }>()
    const [searchParams] = useSearchParams()
    const isEdit = Boolean(id)
    const frontendsApi = useFrontendsApi()
    const { errorMessage: domainErrorMessage } = useDomainsApi()
    const variableMapErrorMessage = useVariableMapErrorMessage()
    const errorMessage = (error: Error) => frontendsApi.errorMessage(error) ?? variableMapErrorMessage(error) ?? domainErrorMessage(error)
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const template = searchParams.get("template")
    // Created under a parent: a DOCKER cannot have one, so it is a BUNDLE
    const parentId = isEdit ? null : searchParams.get("parentId")
    // Opened from a domain page: the frontend is created in it, and the page is where we go back
    const initialDomainId = searchParams.get("domainId")
    const assistantEnabled = useProjectAiModels().enabled

    const formSchema = useMemo(
        () =>
            createFormSchema({
                path: t("backends.path_invalid"),
                exposurePath: t("backends.exposure_path_invalid"),
                exposurePathRequired: t("backends.exposure_path_required"),
                versionRequired: t("frontend.validation.version_required"),
                versionInvalid: t("backends.version_invalid"),
                hostUrlRequired: t("frontend.validation.host_url_required"),
                canaryPercentage: t("frontend.validation.canary_percentage"),
                designSystemPackageRequired: t("designSystem.fields.packageNameRequired"),
                designSystemPackageInvalid: t("designSystem.fields.packageNameInvalid"),
                designSystemDocsUrlInvalid: t("designSystem.fields.docsUrlInvalid"),
                ...resourceMessages(t)
            }),
        [t]
    )

    const form = useForm<FormInput, unknown, FormValues>({
        resolver: zodResolver(formSchema),
        defaultValues: frontendFormDefaults({ frontend, storages, repositories, configMaps, secrets, initialDomainId, template })
    })

    const notificationToast = useToastNotificationStore()

    // A template knows the file its build is served by (index.js for single-spa, parcel.js for
    // micro-lc): it replaces the generic default, unless the user already typed one.
    const { getMarketBySlug } = useMarketApi()
    const templateQuery = useQuery({
        queryKey: ["market", template],
        queryFn: () => getMarketBySlug(template as string),
        enabled: Boolean(template) && !isEdit
    })
    const templateEntryPoint = templateQuery.data?.entryPoint

    useEffect(() => {
        if (templateEntryPoint && !form.getFieldState("host.entryPoint").isDirty) {
            form.setValue("host.entryPoint", templateEntryPoint)
        }
    }, [templateEntryPoint, form])

    const kind = form.watch("kind")
    const isDocker = kind === FrontendKind.DOCKER
    const designSystemOverride = form.watch("designSystemOverride")

    // A new DOCKER starts with no version, which its pipeline or this form sets; a new BUNDLE starts at 1.0.0
    useEffect(() => {
        if (!isEdit) form.setValue("version", isDocker ? "" : "1.0.0")
    }, [isDocker, isEdit, form])

    const { linkedTab, shownTab, selectTab, tabHasErrors, onInvalid } = useFrontendFormTabs({ form, isEdit, isDocker })

    const onSubmit = async (data: FormValues) => {
        const dataToSend = toFrontendPayload(data, { isEdit, template, isVersionDirty: () => Boolean(form.formState.dirtyFields.version) })

        if (isEdit) {
            await frontendsApi.update(id, dataToSend, { customErrorMessage: errorMessage })
            notificationToast.showSuccessNotification({
                message: t("frontend.updated_success_message")
            })
            await queryClient.invalidateQueries({ queryKey: ["mfe", id] })
            navigate(`/frontend/${id}`)
        } else {
            if (parentId) {
                dataToSend.parentIds = [parentId]
            }

            const created = (await frontendsApi.create(dataToSend, { customErrorMessage: errorMessage })) as Frontend | undefined
            notificationToast.showSuccessNotification({
                message: t("frontend.created_success_message")
            })
            navigate(initialDomainId ? `/domain/${initialDomainId}` : created?._id ? `/frontend/${created._id}` : "/frontends")
        }
        await queryClient.invalidateQueries({ queryKey: ["frontends-by-project-id"] })
    }

    const aiAvailable = isEdit && isAiEditAvailable(frontend, assistantEnabled)

    // Edit with AI used to be a tab of this page: old links to it open the AI workspace.
    if (isEdit && linkedTab === "aiChange") {
        const change = searchParams.get("change")
        return <Navigate to={`/frontend/${id}${change ? `?change=${encodeURIComponent(change)}` : ""}`} replace />
    }

    const content = (
        <FormProvider {...form}>
            <form onSubmit={form.handleSubmit(onSubmit, onInvalid)} className="space-y-6">
                <FetchDataTemplateCard slug={template} />

                <Tabs value={shownTab} onValueChange={value => selectTab(value as FormTab)} tabsListPosition="fullWidth">
                    <TabsList>
                        <FormTabTrigger value="general" label={t("frontend.tabs.general")} hasErrors={tabHasErrors("general")} />
                        <FormTabTrigger value="context" label={t("frontend.tabs.context")} hasErrors={tabHasErrors("context")} />
                        {/* A DOCKER runs a container, as a backend: the same Runtime tab */}
                        {isDocker ? (
                            <FormTabTrigger value="runtime" label={t("backends.tabs.runtime")} hasErrors={tabHasErrors("runtime")} />
                        ) : (
                            <FormTabTrigger value="hosting" label={t("frontend.tabs.hosting")} hasErrors={tabHasErrors("hosting")} />
                        )}
                        {isEdit && (
                            <TabsTrigger value="danger" className="flex-1">
                                {t("frontend.tabs.danger_zone")}
                            </TabsTrigger>
                        )}
                    </TabsList>

                    {/* forceMount keeps every tab registered: switching tab must not drop the values or re-run the repository lookups. */}
                    <TabsContent value="general" forceMount>
                        <GeneralTab id={id} isEdit={isEdit} isDocker={isDocker} template={template} parentId={parentId} frontend={frontend} versions={versions} repositories={repositories} />
                    </TabsContent>

                    <TabsContent value="context" forceMount>
                        <ContextTab designSystemOverride={designSystemOverride} />
                    </TabsContent>

                    {isDocker ? (
                        <TabsContent value="runtime" forceMount>
                            <div className="flex flex-col gap-6">
                                <BackendRuntimeFields />
                                <BackendEndpointFields environments={environments} placeholder="/shell" />
                                <BackendEnvFields />
                                <BackendVariableMapsFields configMaps={configMaps} secrets={secrets} />
                            </div>
                        </TabsContent>
                    ) : (
                        <TabsContent value="hosting" forceMount>
                            <HostingSection storages={storages} />
                        </TabsContent>
                    )}

                    {isEdit && (
                        <TabsContent value="danger">
                            <DangerZoneRemoveFrontend frontend={frontend} />
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

    if (isEdit && frontend) {
        return (
            <div className="flex min-h-full flex-col gap-6">
                <FrontendHeader frontend={frontend} active="settings" aiAvailable={aiAvailable} />
                {content}
            </div>
        )
    }

    return (
        <SinglePageLayout title={isEdit ? t("frontend.edit") : t("frontend.add_new")} description={isEdit ? t("frontend.edit_description") : t("frontend.add_new_description")}>
            {content}
        </SinglePageLayout>
    )
}
