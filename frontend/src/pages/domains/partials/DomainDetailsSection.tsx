import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@flightroom/design-system"
import { zodResolver } from "@hookform/resolvers/zod"
import { useQueryClient } from "@tanstack/react-query"
import { Save } from "lucide-react"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import useDomainsApi, { type Domain } from "@/hooks/apiClients/useDomainsApi"
import { useIsProjectViewer } from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import { DomainFormFields, type DomainFormValues, useDomainFormSchema } from "./DomainFormDialog"

/** Name, description and AI context of the domain, edited in place: the same fields as the dialog of the domains list */
export const DomainDetailsSection: React.FC<{ domain: Domain }> = ({ domain }) => {
    const { t } = useTranslation()
    const domainsApi = useDomainsApi()
    const queryClient = useQueryClient()
    const notifications = useToastNotificationStore()
    const isViewer = useIsProjectViewer()
    const values = { name: domain.name, description: domain.description ?? "", context: domain.context ?? "" }
    // Follows the domain as it is read again, keeping what is being typed
    const form = useForm<DomainFormValues>({ resolver: zodResolver(useDomainFormSchema()), values, resetOptions: { keepDirtyValues: true } })
    const { isSubmitting, isDirty } = form.formState

    const onSubmit = async (data: DomainFormValues) => {
        try {
            await domainsApi.update(domain._id, data)
        } catch {
            // The API client has told the error already: what was typed stays in the form
            return
        }
        notifications.showSuccessNotification({ message: t("domains.updated_success_message") })
        form.reset(data)
        await Promise.all([queryClient.invalidateQueries({ queryKey: ["domain", domain._id] }), queryClient.invalidateQueries({ queryKey: ["domains"] })])
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("domains.settings.details_title")}</CardTitle>
                <CardDescription>{t("domains.form.description")}</CardDescription>
            </CardHeader>
            <CardContent className="pt-3">
                <FormProvider {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-2">
                        <DomainFormFields disabled={isViewer} />
                        {!isViewer && (
                            <div className="flex justify-end pt-2">
                                <Button type="submit" disabled={!isDirty || isSubmitting} loading={isSubmitting} dataTestId="domain-details-save">
                                    <Save />
                                    {t("common.save")}
                                </Button>
                            </div>
                        )}
                    </form>
                </FormProvider>
            </CardContent>
        </Card>
    )
}

export default DomainDetailsSection
