import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, SelectField, Spinner } from "@flightroom/design-system"
import { zodResolver } from "@hookform/resolvers/zod"
import { useQuery } from "@tanstack/react-query"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { z } from "zod"
import { Button } from "@/components/atoms"
import TextField from "@/components/input/TextField.rhf"
import { ApiStatusHandler } from "@/components/organisms"
import useBackendsApi, { Backend } from "@/hooks/apiClients/useBackendsApi"
import useCodeRepositoriesApi from "@/hooks/apiClients/useCodeRepositoriesApi"
import useToastNotificationStore from "@/store/useToastNotificationStore"

interface BackendBuildDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    /** A backend, or anything built the same way from its repository (a maintenance agent) */
    backend: Pick<Backend, "_id" | "name" | "codeRepository">
    onBuilt?: () => void
    /** Where the build is asked for: the backend's by default */
    build?: (id: string, version: string, branch?: string) => Promise<unknown>
}

const FormDataSchema = z.object({
    version: z.string().min(1),
    branch: z.string()
})

type FormData = z.infer<typeof FormDataSchema>

/** Same flow as the frontend build: the tag it creates is what triggers the backend pipeline. */
export const BackendBuildDialog: React.FC<BackendBuildDialogProps> = ({ open, onOpenChange, backend, onBuilt, build }) => {
    const { t } = useTranslation()
    const backendsApi = useBackendsApi()
    const startBuild = build ?? backendsApi.build
    const { getBranches } = useCodeRepositoriesApi()
    const notifications = useToastNotificationStore()
    const form = useForm<FormData>({ resolver: zodResolver(FormDataSchema) })
    const repository = backend.codeRepository

    const branchesQuery = useQuery({
        queryKey: ["backend-branches", backend._id],
        queryFn: async () => {
            const name = repository?.gitlab ? repository.repositoryId : repository?.name || repository?.repositoryId
            const branches = await getBranches(repository!.codeRepositoryId, name!)
            const defaultBranch = branches.find(b => b.default) || branches?.[0]
            if (defaultBranch) {
                form.setValue("branch", defaultBranch.branch, { shouldValidate: true, shouldTouch: true, shouldDirty: true })
            }
            return branches
        },
        enabled: open && !!repository?.codeRepositoryId
    })

    const onSubmit = async (values: FormData) => {
        await startBuild(backend._id!, values.version, values.branch)
        notifications.showSuccessNotification({ message: t("backends.build.success", { name: backend.name }) })
        onBuilt?.()
        onOpenChange(false)
    }

    const handleClose = () => {
        form.reset()
        onOpenChange(false)
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <FormProvider {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)}>
                        <DialogHeader>
                            <DialogTitle>{t("backends.build.title", { name: backend.name })}</DialogTitle>
                        </DialogHeader>
                        <div className="space-y-2 mt-2 mb-4">
                            <ApiStatusHandler queries={[branchesQuery]} loadingComponent={<Spinner size={32} centerScreen={false} label={t("common.loading")} />}>
                                {branchesQuery.data && branchesQuery.data.length > 1 ? (
                                    <SelectField name="branch" label={t("backends.build.branch")} options={branchesQuery.data.map(b => ({ value: b.branch, label: b.branch }))} />
                                ) : (
                                    <p className="text-sm text-foreground-secondary">{branchesQuery.data?.[0]?.branch ?? t("backends.build.noBranches")}</p>
                                )}
                            </ApiStatusHandler>
                            <TextField name="version" label={t("backends.build.version")} placeholder={t("backends.build.versionPlaceholder")} required />
                        </div>
                        <DialogFooter>
                            <Button type="button" variant="secondary" onClick={handleClose} disabled={form.formState.isSubmitting}>
                                {t("common.cancel")}
                            </Button>
                            <Button type="submit" disabled={form.formState.isSubmitting || !form.formState.isValid || branchesQuery.isLoading}>
                                {form.formState.isSubmitting ? t("backends.build.building") : t("backends.build.start")}
                            </Button>
                        </DialogFooter>
                    </form>
                </FormProvider>
            </DialogContent>
        </Dialog>
    )
}

export default BackendBuildDialog
