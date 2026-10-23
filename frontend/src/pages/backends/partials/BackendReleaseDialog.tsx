import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@flightroom/design-system"
import { zodResolver } from "@hookform/resolvers/zod"
import { useEffect, useMemo } from "react"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { z } from "zod"
import { Button } from "@/components/atoms"
import TextField from "@/components/input/TextField.rhf"
import useBackendsApi, { Backend } from "@/hooks/apiClients/useBackendsApi"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import { BACKEND_VERSION } from "./backendVariables"

interface BackendReleaseDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    backend: Backend
    onSaved?: () => void
}

/** Sets by hand the version deployed, for a backend whose CI does not register one: the tag of an image already pushed. */
export const BackendReleaseDialog: React.FC<BackendReleaseDialogProps> = ({ open, onOpenChange, backend, onSaved }) => {
    const { t } = useTranslation()
    const { update } = useBackendsApi()
    const notifications = useToastNotificationStore()
    const schema = useMemo(() => z.object({ version: z.string().trim().regex(BACKEND_VERSION, t("backends.version_invalid")) }), [t])
    const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { version: backend.version ?? "" } })

    // Opened again after the pipeline moved the version on: it starts from the current one
    useEffect(() => {
        if (open) form.reset({ version: backend.version ?? "" })
    }, [open, backend.version, form])

    const onSubmit = async ({ version }: z.infer<typeof schema>) => {
        await update(backend._id!, { version })
        notifications.showSuccessNotification({ message: t("backends.release.success", { name: backend.name, version }) })
        onSaved?.()
        onOpenChange(false)
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <FormProvider {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)}>
                        <DialogHeader>
                            <DialogTitle>{t("backends.release.title", { name: backend.name })}</DialogTitle>
                            <DialogDescription>{t("backends.release.description")}</DialogDescription>
                        </DialogHeader>
                        <div className="mt-2 mb-4">
                            <TextField name="version" label={t("backends.release.version")} placeholder={t("backends.release.placeholder")} required />
                        </div>
                        <DialogFooter>
                            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={form.formState.isSubmitting}>
                                {t("common.cancel")}
                            </Button>
                            <Button type="submit" disabled={form.formState.isSubmitting || !form.formState.isDirty}>
                                {form.formState.isSubmitting ? t("backends.release.saving") : t("backends.release.save")}
                            </Button>
                        </DialogFooter>
                    </form>
                </FormProvider>
            </DialogContent>
        </Dialog>
    )
}

export default BackendReleaseDialog
