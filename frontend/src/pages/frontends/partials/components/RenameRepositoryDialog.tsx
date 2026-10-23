import { Alert, AlertDescription, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@flightroom/design-system"
import { zodResolver } from "@hookform/resolvers/zod"
import { useQueryClient } from "@tanstack/react-query"
import { KeyboardEvent } from "react"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { z } from "zod"
import { Button } from "@/components/atoms"
import useFrontendsApi, { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import { errorCodeOf } from "@/hooks/useApiClient"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import TextField from "../../../../components/input/TextField.rhf"

interface RenameRepositoryDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    frontendId: string
    currentName: string
    onRenamed: (frontend: Frontend) => void
}

// Stesse regole del backend: nome valido per i provider e senza suffisso .git o .atom
const REPOSITORY_NAME_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9_-])?$/

const ERROR_KEYS: Record<string, string> = {
    INVALID_REPOSITORY_NAME: "frontend.rename_repository.errors.invalid_name",
    REPOSITORY_NAME_TAKEN: "frontend.rename_repository.errors.name_taken",
    REPOSITORY_NOT_LINKED: "frontend.rename_repository.errors.not_linked",
    REPOSITORY_LINK_INCONSISTENT: "frontend.rename_repository.errors.link_inconsistent"
}

export function RenameRepositoryDialog({ open, onOpenChange, frontendId, currentName, onRenamed }: RenameRepositoryDialogProps) {
    const { t } = useTranslation()
    const { renameRepository } = useFrontendsApi()
    const notifications = useToastNotificationStore()
    const queryClient = useQueryClient()

    const FormDataSchema = z.object({
        name: z
            .string()
            .trim()
            .min(1, t("frontend.rename_repository.validation.required"))
            .regex(REPOSITORY_NAME_REGEX, t("frontend.rename_repository.validation.invalid"))
            .refine(value => ![".git", ".atom"].some(suffix => value.toLowerCase().endsWith(suffix)), t("frontend.rename_repository.validation.git_suffix"))
            .refine(value => value !== currentName, t("frontend.rename_repository.validation.unchanged"))
    })

    type FormData = z.infer<typeof FormDataSchema>

    const form = useForm<FormData>({
        resolver: zodResolver(FormDataSchema),
        mode: "onChange",
        values: { name: currentName }
    })

    const onSubmit = async (values: FormData) => {
        try {
            const frontend = await renameRepository(frontendId, values.name)
            queryClient.setQueryData(["mfe", frontendId], frontend)
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: ["frontend", frontendId] }),
                queryClient.invalidateQueries({ queryKey: ["frontends-by-project-id"] }),
                queryClient.invalidateQueries({ queryKey: ["branches", frontendId] })
            ])
            onRenamed(frontend)
            notifications.showSuccessNotification({ message: t("frontend.rename_repository.success", { name: values.name }) })
            onOpenChange(false)
        } catch (error) {
            const code = errorCodeOf(error as Error)
            const serverMessage = (error as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message
            const key = ERROR_KEYS[code ?? ""]
            const message = key
                ? t(key)
                : code === "REPOSITORY_RENAME_FAILED"
                  ? t("frontend.rename_repository.errors.rename_failed", { reason: serverMessage ?? "" })
                  : t("frontend.rename_repository.errors.generic")
            notifications.showErrorNotification({ message })
        }
    }

    // Il dialog vive dentro il form del frontend: niente <form> annidato, Invio manda la rinomina
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Enter" && !form.formState.isSubmitting) {
            event.preventDefault()
            form.handleSubmit(onSubmit)()
        }
    }

    const handleClose = () => {
        form.reset()
        onOpenChange(false)
    }

    return (
        <Dialog
            open={open}
            onOpenChange={isOpen => {
                if (!isOpen) form.reset()
                onOpenChange(isOpen)
            }}
        >
            <DialogContent>
                <FormProvider {...form}>
                    <div onKeyDown={onKeyDown}>
                        <DialogHeader>
                            <DialogTitle>{t("frontend.rename_repository.title")}</DialogTitle>
                        </DialogHeader>

                        <div className="space-y-2 mt-2 mb-4">
                            <TextField
                                name="name"
                                label={t("frontend.rename_repository.name_label")}
                                placeholder={t("frontend.rename_repository.name_placeholder")}
                                dataTestId="rename-repository-name"
                                required
                            />
                            <Alert>
                                <AlertDescription>
                                    <p>{t("frontend.rename_repository.warning_remote")}</p>
                                    <code className="block my-1">git remote set-url origin &lt;{t("frontend.rename_repository.new_url")}&gt;</code>
                                    <p>{t("frontend.rename_repository.warning_redirect")}</p>
                                </AlertDescription>
                            </Alert>
                        </div>
                        <DialogFooter>
                            <Button type="button" variant="secondary" onClick={handleClose} disabled={form.formState.isSubmitting} dataTestId="rename-repository-cancel">
                                {t("common.cancel")}
                            </Button>
                            <Button type="button" onClick={form.handleSubmit(onSubmit)} disabled={form.formState.isSubmitting || !form.formState.isValid} dataTestId="rename-repository-confirm">
                                {form.formState.isSubmitting ? t("frontend.rename_repository.renaming") : t("frontend.rename_repository.confirm")}
                            </Button>
                        </DialogFooter>
                    </div>
                </FormProvider>
            </DialogContent>
        </Dialog>
    )
}

export default RenameRepositoryDialog
