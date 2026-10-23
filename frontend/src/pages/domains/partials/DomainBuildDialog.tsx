import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@flightroom/design-system"
import { zodResolver } from "@hookform/resolvers/zod"
import { Hammer } from "lucide-react"
import { useState } from "react"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { z } from "zod"
import { Badge, Button } from "@/components/atoms"
import TextField from "@/components/input/TextField.rhf"
import useDomainsApi, { buildCheckOf, type Domain, type DomainBuildRepository, type DomainBuildResult } from "@/hooks/apiClients/useDomainsApi"
import { useIsProjectViewer } from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"

/** The rule of the backend: the tag becomes, in the pipelines, an image tag and a URL segment */
export const VERSION = /^[A-Za-z0-9._-]{1,128}$/

const STATUS_VARIANTS: Record<DomainBuildRepository["status"], "success" | "outline" | "destructive"> = { tagged: "success", ready: "outline", failed: "destructive" }

/** What a domain build did, or would have done, repository by repository: also shown by the build and deploy of the domain */
export const DomainBuildOutcomes: React.FC<{ result: DomainBuildResult }> = ({ result }) => {
    const { t } = useTranslation()

    /** The translated reason of a failure; a provider error keeps the provider's own words */
    const reasonOf = (repository: DomainBuildRepository) => {
        if (repository.status !== "failed") return undefined
        if (!repository.reason || repository.reason === "PROVIDER_ERROR") return t("domains.build.reasons.PROVIDER_ERROR", { message: repository.message ?? "" })
        return t(`domains.build.reasons.${repository.reason}`, { ref: result.ref, version: result.version })
    }

    return (
        <ul className="my-4 flex flex-col gap-2" data-testid="domain-build-result">
            {result.repositories.map(repository => (
                <li key={repository.id} className="flex flex-col gap-1 rounded-md border border-divider p-3">
                    <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-sm">{repository.repository}</span>
                        <Badge variant={STATUS_VARIANTS[repository.status]}>{t(`domains.build.status.${repository.status}`)}</Badge>
                    </div>
                    <span className="text-xs text-foreground-secondary">{repository.members.map(member => member.name).join(", ")}</span>
                    {reasonOf(repository) && <span className="text-xs text-destructive">{reasonOf(repository)}</span>}
                </li>
            ))}
        </ul>
    )
}

/**
 * Creates a version of the whole domain: the repository of each of its frontends and services is tagged
 * with the same version on the same branch, and each tag starts the pipeline of its repository. The backend
 * checks every repository first and tags none when one fails: the outcome of each is listed after the submit.
 */
export const DomainBuildButton: React.FC<{ domain: Domain }> = ({ domain }) => {
    const { t } = useTranslation()
    const domainsApi = useDomainsApi()
    const notifications = useToastNotificationStore()
    const [open, setOpen] = useState(false)
    const [result, setResult] = useState<DomainBuildResult | undefined>()
    const isViewer = useIsProjectViewer()

    const schema = z.object({
        version: z.string().regex(VERSION, t("domains.build.errors.version_invalid")),
        branch: z.string().max(255)
    })
    const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), mode: "onChange", defaultValues: { version: "", branch: "main" } })
    const submitting = form.formState.isSubmitting

    const onSubmit = async (values: z.infer<typeof schema>) => {
        try {
            const built = await domainsApi.build(domain._id, values.version, values.branch.trim() || undefined)
            setResult(built)
            const failed = built.repositories.filter(repository => repository.status === "failed").length
            if (failed === 0) {
                notifications.showSuccessNotification({ message: t("domains.build.success", { domain: domain.name, version: built.version, count: built.repositories.length }) })
            } else {
                notifications.showWarningNotification({ message: t("domains.build.partial", { count: failed }) })
            }
        } catch (error) {
            // The check refused the build: its outcome per repository says why, the toast is already shown
            setResult(buildCheckOf(error as Error))
        }
    }

    const changeOpen = (value: boolean) => {
        if (submitting) return
        setOpen(value)
        if (!value) {
            setResult(undefined)
            form.reset()
        }
    }

    // A viewer may look, not release
    if (isViewer) return null

    return (
        <>
            <Button variant="secondary" onClick={() => setOpen(true)} dataTestId="domain-build">
                <Hammer />
                {t("domains.build.action")}
            </Button>
            <Dialog open={open} onOpenChange={changeOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("domains.build.title", { domain: domain.name })}</DialogTitle>
                        <DialogDescription>{result ? t("domains.build.result_description", { version: result.version, ref: result.ref }) : t("domains.build.description")}</DialogDescription>
                    </DialogHeader>
                    {result ? (
                        <>
                            <DomainBuildOutcomes result={result} />
                            <DialogFooter>
                                <Button variant="secondary" type="button" onClick={() => setResult(undefined)}>
                                    {t("common.back")}
                                </Button>
                                <Button type="button" onClick={() => changeOpen(false)}>
                                    {t("common.close")}
                                </Button>
                            </DialogFooter>
                        </>
                    ) : (
                        <FormProvider {...form}>
                            <form onSubmit={form.handleSubmit(onSubmit)}>
                                <div className="mt-2 mb-4 space-y-2">
                                    <TextField name="version" label={t("domains.build.version")} placeholder={t("services.build.versionPlaceholder")} required />
                                    <TextField name="branch" label={t("domains.build.branch")} placeholder="main" />
                                    <p className="text-xs text-foreground-secondary">{t("domains.build.branch_hint")}</p>
                                </div>
                                <DialogFooter>
                                    <Button type="button" variant="secondary" onClick={() => changeOpen(false)} disabled={submitting}>
                                        {t("common.cancel")}
                                    </Button>
                                    <Button
                                        type="submit"
                                        disabled={submitting || !form.formState.isValid}
                                        loading={submitting}
                                        loadingLabel={t("services.build.building")}
                                        dataTestId="domain-build-confirm"
                                    >
                                        <Hammer />
                                        {t("domains.build.start")}
                                    </Button>
                                </DialogFooter>
                            </form>
                        </FormProvider>
                    )}
                </DialogContent>
            </Dialog>
        </>
    )
}

export default DomainBuildButton
