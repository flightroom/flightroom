import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@flightroom/design-system"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import useOrganizationApi, { ORGANIZATIONS_QUERY_KEY, Organization } from "@/hooks/apiClients/useOrganizationApi"
import { DesignSystemFields, type DesignSystemFormValues, designSystemFormValues, toDesignSystem } from "@/pages/settings/partials/DesignSystemFields"
import { SettingsDetails } from "@/pages/settings/partials/SettingsDetails"
import useOrganizationStore from "@/store/useOrganizationStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"

interface OrganizationDesignSystemSectionProps {
    organization: Organization
    canAdminister: boolean
}

/**
 * The design system of every project that does not pick its own. Only who administers the organization changes it:
 * the others read which one their projects inherit.
 */
export const OrganizationDesignSystemSection: React.FC<OrganizationDesignSystemSectionProps> = ({ organization, canAdminister }) => {
    const { t } = useTranslation()
    const organizationApi = useOrganizationApi()
    const notifications = useToastNotificationStore()
    const queryClient = useQueryClient()
    const { setOrganization } = useOrganizationStore()
    const designSystem = organization.designSystem

    const form = useForm<DesignSystemFormValues>({ defaultValues: designSystemFormValues(designSystem) })

    // Switching organization keeps this page mounted, so the form has to follow the new one.
    useEffect(() => {
        form.reset(designSystemFormValues(designSystem))
    }, [designSystem, form])

    const updateMutation = useMutation({
        // Without a package the design system is removed, which the API expresses as an explicit null
        mutationFn: (values: DesignSystemFormValues) => organizationApi.updateOrganization(organization._id, { designSystem: toDesignSystem(values) }),
        onSuccess: updated => {
            // The project settings and the frontend form read from the store the design system projects inherit
            setOrganization({ ...organization, designSystem: updated.designSystem })
            queryClient.invalidateQueries({ queryKey: ORGANIZATIONS_QUERY_KEY })
            notifications.showSuccessNotification({ message: t("designSystem.organization.saved") })
        },
        onError: () => {
            notifications.showErrorNotification({ message: t("designSystem.organization.save_failed") })
        }
    })

    return (
        <Card className="pt-4">
            <CardHeader>
                <CardTitle as="h2">{t("designSystem.organization.title")}</CardTitle>
                <CardDescription>{t("designSystem.organization.subtitle")}</CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
                {canAdminister ? (
                    <FormProvider {...form}>
                        <form onSubmit={form.handleSubmit(values => updateMutation.mutate(values))} className="flex flex-col gap-4">
                            <SettingsDetails summary={t("settings.howItWorks")} dataTestId="organization-design-system-details">
                                <p>{t("designSystem.organization.details")}</p>
                            </SettingsDetails>

                            <DesignSystemFields<DesignSystemFormValues> dataTestId="organization-design-system" />

                            <div className="flex justify-end">
                                <Button type="submit" loading={updateMutation.isPending} loadingLabel={t("common.loading")} dataTestId="organization-design-system-save">
                                    {t("common.save")}
                                </Button>
                            </div>
                        </form>
                    </FormProvider>
                ) : (
                    <div className="flex flex-col gap-1 text-sm" data-testid="organization-design-system-readonly">
                        {designSystem?.packageName ? (
                            <>
                                <span className="font-medium text-foreground">
                                    {designSystem.packageName}
                                    {designSystem.version && <span className="font-normal text-foreground-secondary"> {designSystem.version}</span>}
                                </span>
                                {designSystem.docsUrl && (
                                    <a href={designSystem.docsUrl} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">
                                        {t("designSystem.organization.docs")}
                                    </a>
                                )}
                            </>
                        ) : (
                            <span className="text-foreground-secondary">{t("designSystem.organization.none")}</span>
                        )}
                        <span className="text-foreground-secondary">{t("designSystem.organization.adminOnly")}</span>
                    </div>
                )}
            </CardContent>
        </Card>
    )
}

export default OrganizationDesignSystemSection
