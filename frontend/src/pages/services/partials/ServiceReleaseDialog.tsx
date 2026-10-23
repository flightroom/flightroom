import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@flightroom/design-system"
import { zodResolver } from "@hookform/resolvers/zod"
import { useEffect, useMemo } from "react"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { z } from "zod"
import { Button } from "@/components/atoms"
import TextField from "@/components/input/TextField.rhf"
import useServicesApi, { Service } from "@/hooks/apiClients/useServicesApi"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import { SERVICE_VERSION } from "./serviceVariables"

interface ServiceReleaseDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    service: Service
    onSaved?: () => void
}

/** Sets by hand the version deployed, for a service whose CI does not register one: the tag of an image already pushed. */
export const ServiceReleaseDialog: React.FC<ServiceReleaseDialogProps> = ({ open, onOpenChange, service, onSaved }) => {
    const { t } = useTranslation()
    const { update } = useServicesApi()
    const notifications = useToastNotificationStore()
    const schema = useMemo(() => z.object({ version: z.string().trim().regex(SERVICE_VERSION, t("services.version_invalid")) }), [t])
    const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { version: service.version ?? "" } })

    // Opened again after the pipeline moved the version on: it starts from the current one
    useEffect(() => {
        if (open) form.reset({ version: service.version ?? "" })
    }, [open, service.version, form])

    const onSubmit = async ({ version }: z.infer<typeof schema>) => {
        await update(service._id!, { version })
        notifications.showSuccessNotification({ message: t("services.release.success", { name: service.name, version }) })
        onSaved?.()
        onOpenChange(false)
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <FormProvider {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)}>
                        <DialogHeader>
                            <DialogTitle>{t("services.release.title", { name: service.name })}</DialogTitle>
                            <DialogDescription>{t("services.release.description")}</DialogDescription>
                        </DialogHeader>
                        <div className="mt-2 mb-4">
                            <TextField name="version" label={t("services.release.version")} placeholder={t("services.release.placeholder")} required />
                        </div>
                        <DialogFooter>
                            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={form.formState.isSubmitting}>
                                {t("common.cancel")}
                            </Button>
                            <Button type="submit" disabled={form.formState.isSubmitting || !form.formState.isDirty}>
                                {form.formState.isSubmitting ? t("services.release.saving") : t("services.release.save")}
                            </Button>
                        </DialogFooter>
                    </form>
                </FormProvider>
            </DialogContent>
        </Dialog>
    )
}

export default ServiceReleaseDialog
