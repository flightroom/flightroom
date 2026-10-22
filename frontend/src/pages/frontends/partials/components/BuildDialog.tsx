import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, SelectField, Spinner } from "@flightroom/design-system"
import { zodResolver } from "@hookform/resolvers/zod"
import { useQuery } from "@tanstack/react-query"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { z } from "zod"
import { Button } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import useCodeRepositoriesApi from "@/hooks/apiClients/useCodeRepositoriesApi"
import useFrontendsApi from "@/hooks/apiClients/useFrontendsApi"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import TextField from "../../../../components/input/TextField.rhf"

interface BuildDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    frontendId: string
    frontendName: string
}

const FormDataSchema = z.object({
    version: z.string(),
    branch: z.string()
})

type FormData = z.infer<typeof FormDataSchema>

export function BuildDialog({ open, onOpenChange, frontendId, frontendName }: BuildDialogProps) {
    const { t } = useTranslation()
    const { build, getSingle } = useFrontendsApi()
    const { getBranches } = useCodeRepositoriesApi()
    const notifications = useToastNotificationStore()

    // Get frontend data first
    const frontendQuery = useQuery({
        queryKey: ["frontend", frontendId],
        queryFn: () => getSingle(frontendId),
        enabled: open && !!frontendId
    })

    const form = useForm<FormData>({
        resolver: zodResolver(FormDataSchema)
    })

    const branchesQuery = useQuery({
        queryKey: ["branches", frontendId],
        queryFn: async () => {
            const mfe = frontendQuery.data

            let name = mfe.codeRepository.name || mfe.codeRepository.repositoryId
            if (mfe.codeRepository.gitlab) {
                name = mfe.codeRepository.repositoryId
            }

            const branches = await getBranches(mfe.codeRepository.codeRepositoryId, name)
            const defaultBranch = branches.find(b => b.default) || branches?.[0]
            if (defaultBranch) {
                form.setValue("branch", defaultBranch.branch, {
                    shouldValidate: true,
                    shouldTouch: true,
                    shouldDirty: true
                })
            }
            return branches
        },
        enabled: open && !!frontendId && !!frontendQuery.data?.codeRepository?.codeRepositoryId
    })

    const onSubmit = async (values: FormData) => {
        await build(frontendId, values.version, values.branch)
        notifications.showSuccessNotification({
            message: t("frontend.build.buildSuccess", { name: frontendName })
        })
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
                            <DialogTitle>{t("frontend.build.title", { name: frontendName })}</DialogTitle>
                        </DialogHeader>

                        <div className="space-y-2 mt-2 mb-4">
                            <ApiStatusHandler queries={[branchesQuery]} loadingComponent={<Spinner size={32} centerScreen={false} label={t("common.loading")} />}>
                                {branchesQuery.data ? (
                                    <>
                                        {branchesQuery.data.length > 1 ? (
                                            <SelectField
                                                name="branch"
                                                label={t("frontend.build.branch")}
                                                options={branchesQuery.data?.map(b => ({
                                                    value: b.branch,
                                                    label: b.branch
                                                }))}
                                            />
                                        ) : (
                                            <label>{branchesQuery.data[0]?.branch}</label>
                                        )}
                                    </>
                                ) : (
                                    <>No Branches</>
                                )}
                            </ApiStatusHandler>
                            <TextField name="version" label={t("frontend.build.version")} placeholder={t("frontend.build.versionPlaceholder")} />
                        </div>
                        <DialogFooter>
                            <Button type="button" variant="secondary" onClick={handleClose} disabled={form.formState.isSubmitting}>
                                {t("common.cancel")}
                            </Button>
                            <Button type="submit" disabled={form.formState.isSubmitting || !form.formState.isValid || frontendQuery.isLoading || branchesQuery.isLoading}>
                                {form.formState.isSubmitting ? t("frontend.build.building") : t("frontend.build.startBuild")}
                            </Button>
                        </DialogFooter>
                    </form>
                </FormProvider>
            </DialogContent>
        </Dialog>
    )
}

export default BuildDialog
