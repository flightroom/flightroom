import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, SelectField, Spinner } from "@flightroom/design-system"
import { zodResolver } from "@hookform/resolvers/zod"
import { useQueryClient } from "@tanstack/react-query"
import { Play } from "lucide-react"
import { useEffect, useMemo } from "react"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { z } from "zod"
import { Button } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import useMaintenanceAgentsApi, { MaintenanceAgent } from "@/hooks/apiClients/useMaintenanceAgentsApi"
import { useProjectEnvironmentsQuery } from "@/pages/backends/partials/backendVariables"
import useToastNotificationStore from "@/store/useToastNotificationStore"

interface MaintenanceRunDialogProps {
    /** The agent to run; the dialog is closed without one */
    agent?: Pick<MaintenanceAgent, "_id" | "name" | "kind" | "runPath">
    onOpenChange: (open: boolean) => void
}

/** Play: the agent runs now in the environment picked, the same as its schedule would start it there. */
export const MaintenanceRunDialog: React.FC<MaintenanceRunDialogProps> = ({ agent, onOpenChange }) => {
    const { t } = useTranslation()
    const api = useMaintenanceAgentsApi()
    const queryClient = useQueryClient()
    const notifications = useToastNotificationStore()
    const environmentsQuery = useProjectEnvironmentsQuery()
    const environments = environmentsQuery.data ?? []
    const formSchema = useMemo(() => z.object({ environmentId: z.string().min(1, t("maintenance.run.environment_required")) }), [t])
    const form = useForm<z.infer<typeof formSchema>>({ resolver: zodResolver(formSchema), defaultValues: { environmentId: "" } })
    const open = Boolean(agent)

    // The first environment in the project's order, unless one was picked already
    useEffect(() => {
        if (open && !form.getValues("environmentId") && environments[0]?._id) form.setValue("environmentId", environments[0]._id, { shouldValidate: true })
    }, [open, environments, form])

    if (!agent) return null

    const onSubmit = async ({ environmentId }: { environmentId: string }) => {
        const environment = environments.find(candidate => candidate._id === environmentId)?.name ?? ""
        const run = await api.run(agent._id, environmentId)
        if (run.status === "failed") {
            notifications.showErrorNotification({ message: t("maintenance.run.refused", { name: agent.name, environment, error: run.error ?? t("app.error.generic") }) })
        } else {
            notifications.showSuccessNotification({ message: t("maintenance.run.started", { name: agent.name, environment }) })
        }
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["maintenance-agent-runs", agent._id] }),
            queryClient.invalidateQueries({ queryKey: ["maintenance-agent", agent._id] }),
            queryClient.invalidateQueries({ queryKey: ["maintenance-agents"] })
        ])
        onOpenChange(false)
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <FormProvider {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)}>
                        <DialogHeader>
                            <DialogTitle>{t("maintenance.run.title", { name: agent.name })}</DialogTitle>
                            <DialogDescription>
                                {agent.kind === "job" ? t("maintenance.run.description_job") : t("maintenance.run.description_container", { path: agent.runPath || "/run" })}
                            </DialogDescription>
                        </DialogHeader>
                        <div className="mt-2 mb-4">
                            <ApiStatusHandler queries={[environmentsQuery]} loadingComponent={<Spinner size={32} centerScreen={false} label={t("common.loading")} />}>
                                {environments.length > 0 ? (
                                    <SelectField
                                        name="environmentId"
                                        label={t("maintenance.run.environment")}
                                        options={environments.map(environment => ({ value: environment._id!, label: environment.name }))}
                                        className="w-full"
                                        required
                                    />
                                ) : (
                                    <p className="text-sm text-foreground-secondary">{t("maintenance.run.no_environments")}</p>
                                )}
                            </ApiStatusHandler>
                        </div>
                        <DialogFooter>
                            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={form.formState.isSubmitting}>
                                {t("common.cancel")}
                            </Button>
                            <Button type="submit" disabled={form.formState.isSubmitting || environments.length === 0}>
                                <Play />
                                {form.formState.isSubmitting ? t("maintenance.run.starting") : t("maintenance.run.start")}
                            </Button>
                        </DialogFooter>
                    </form>
                </FormProvider>
            </DialogContent>
        </Dialog>
    )
}

export default MaintenanceRunDialog
