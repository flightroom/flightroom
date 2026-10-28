import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Label,
    RadioGroup,
    RadioGroupItem,
    Select,
    SelectContent,
    SelectControl,
    SelectItem,
    SelectTrigger,
    SelectValue
} from "@flightroom/design-system"
import { zodResolver } from "@hookform/resolvers/zod"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useState } from "react"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import type { DomainExposureKind } from "@/hooks/apiClients/useAiJobsApi"
import useBackendsApi from "@/hooks/apiClients/useBackendsApi"
import useDomainsApi, { Domain } from "@/hooks/apiClients/useDomainsApi"
import useFrontendsApi from "@/hooks/apiClients/useFrontendsApi"
import useMarketApi, { Market } from "@/hooks/apiClients/useMarketApi"
import useProjectStore from "@/store/useProjectStore"
import { isRecommendedTemplate, type ProjectTechnologies } from "@/utils/technologies"
import { DomainFormFields, DomainFormValues, useDomainFormSchema } from "./DomainFormDialog"
import { repositoryNameFor, type ScaffoldItem } from "./DomainScaffoldDialog"

const EXPOSURES: DomainExposureKind[] = ["remote", "standalone", "none"]

/** An application of its own starts from a host template, the project's technology first; the dialog that follows picks the default otherwise. */
const hostTemplateOf = (templates: Market[], technologies?: ProjectTechnologies) => {
    const hosts = templates.filter(template => !template.comingSoon && template.type?.trim().toLowerCase() === "host")
    return (hosts.find(template => isRecommendedTemplate(template, technologies)) ?? hosts[0])?.slug ?? ""
}

/** `/api/<slug>`, or the first `/api/<slug>-2`, `-3`... no application of the project is published at: two at one path stop every deploy. */
const freeExposurePath = (slug: string, taken: string[]) => {
    const used = new Set(taken.map(path => path.replace(/\/$/, "")))
    let path = `/api/${slug}`
    for (let copy = 2; used.has(path); copy++) path = `/api/${slug}-${copy}`
    return path
}

interface DomainStepsWizardDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    /** The domain was created: the components proposed for its exposure are reviewed and created next. */
    onCreated: (domain: Domain, items: ScaffoldItem[]) => void
}

/**
 * Creating a functional domain without the AI, along the same questions as its wizard: what the application is
 * called and what it does, then where it is exposed. The domain is created, and a frontend and a backend named
 * after it are proposed to the dialog that follows, where they are reviewed and created.
 */
const DomainStepsWizardDialog: React.FC<DomainStepsWizardDialogProps> = ({ open, onOpenChange, onCreated }) => {
    const { t } = useTranslation()
    const id = useId()
    const queryClient = useQueryClient()
    const projectId = useProjectStore(state => state.project?._id)
    const technologies = useProjectStore(state => state.project?.technologies)
    const domainsApi = useDomainsApi()
    const frontendsApi = useFrontendsApi()
    const backendsApi = useBackendsApi()
    const marketApi = useMarketApi()
    const [step, setStep] = useState<"application" | "exposure">("application")
    const [exposure, setExposure] = useState<DomainExposureKind>("standalone")
    const [hostId, setHostId] = useState<string>()
    const form = useForm<DomainFormValues>({ resolver: zodResolver(useDomainFormSchema()) })

    const frontendsQuery = useQuery({ queryKey: ["frontends-by-project-id", projectId], queryFn: () => frontendsApi.getByProjectId(projectId!), enabled: open && !!projectId })
    const backendsQuery = useQuery({ queryKey: ["backends", projectId], queryFn: backendsApi.getAll, enabled: open && !!projectId })
    const templatesQuery = useQuery({ queryKey: ["markets"], queryFn: marketApi.getMarkets, enabled: open })
    const frontends = frontendsQuery.data ?? []
    // What can load it: the tops of the trees, the frontends no other one loads
    const hosts = frontends.filter(frontend => frontend._id && !frontend.parentIds?.length)
    const host = hosts.find(candidate => candidate._id === hostId)

    useEffect(() => {
        if (!open) return
        setStep("application")
        setExposure("standalone")
        setHostId(undefined)
        form.reset({ name: "", description: "", context: "" })
    }, [open, form.reset])

    const create = async (values: DomainFormValues) => {
        const domain = await domainsApi.create(values)
        await queryClient.invalidateQueries({ queryKey: ["domains"] })
        const slug = domain.slug
        const takenPaths = [...(backendsQuery.data ?? []), ...frontends].flatMap(application => (application.exposurePath ? [application.exposurePath] : []))
        const items: ScaffoldItem[] = [
            ...(exposure === "none"
                ? []
                : [
                      {
                          key: "frontend-0",
                          kind: "frontend" as const,
                          name: domain.name,
                          slug,
                          repositoryName: repositoryNameFor(slug, "frontend"),
                          template: exposure === "standalone" ? hostTemplateOf(templatesQuery.data ?? [], technologies) : "",
                          host: exposure === "remote" && host?._id ? { id: host._id, name: host.name } : undefined
                      }
                  ]),
            {
                key: "backend-0",
                kind: "backend",
                name: domain.name,
                slug,
                repositoryName: repositoryNameFor(slug, "backend"),
                template: "",
                // Its frontend calls it from the browser; without one, the other applications of the project do
                exposurePath: exposure === "none" ? "" : freeExposurePath(slug, takenPaths)
            }
        ]
        onOpenChange(false)
        onCreated(domain, items)
    }

    const busy = form.formState.isSubmitting

    return (
        <Dialog open={open} onOpenChange={next => !busy && onOpenChange(next)}>
            <DialogContent className="max-w-2xl">
                <FormProvider {...form}>
                    {/* Enter on the first step moves on to the exposure, it never creates the domain from there */}
                    <form onSubmit={form.handleSubmit(values => (step === "application" ? setStep("exposure") : create(values)))}>
                        <DialogHeader>
                            <DialogTitle>{t("domains.steps.title")}</DialogTitle>
                            <DialogDescription>{t(step === "application" ? "domains.steps.application_description" : "domains.steps.exposure_description")}</DialogDescription>
                        </DialogHeader>
                        <p className="mt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("domains.steps.progress", { step: step === "application" ? 1 : 2, total: 2 })}</p>

                        {step === "application" ? (
                            <div className="space-y-2 py-4">
                                <DomainFormFields disabled={busy} />
                            </div>
                        ) : (
                            <div className="flex flex-col gap-4 py-4">
                                <RadioGroup
                                    value={exposure}
                                    onValueChange={value => setExposure(value as DomainExposureKind)}
                                    aria-label={t("domains.wizard.exposure_label")}
                                    dataTestId="domain-steps-exposure"
                                >
                                    {EXPOSURES.map(kind => (
                                        <div key={kind} className="flex items-start gap-2">
                                            <RadioGroupItem id={`${id}-${kind}`} value={kind} className="mt-0.5" disabled={busy || (kind === "remote" && hosts.length === 0)} />
                                            <Label htmlFor={`${id}-${kind}`} className="flex cursor-pointer flex-col gap-0.5">
                                                <span>{t(`domains.steps.exposure.${kind}`)}</span>
                                                <span className="text-xs font-normal text-foreground-secondary">
                                                    {t(kind === "remote" && hosts.length === 0 ? "domains.steps.exposure.remote_unavailable" : `domains.steps.exposure.${kind}_hint`)}
                                                </span>
                                            </Label>
                                        </div>
                                    ))}
                                </RadioGroup>
                                {exposure === "remote" && (
                                    <SelectControl label={t("domains.steps.host")}>
                                        <Select value={hostId} onValueChange={setHostId} disabled={busy}>
                                            <SelectTrigger dataTestId="domain-steps-host">
                                                <SelectValue placeholder={t("domains.steps.host_placeholder")}>{host?.name}</SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                {hosts.map(candidate => (
                                                    <SelectItem key={candidate._id} value={candidate._id!}>
                                                        {candidate.name}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </SelectControl>
                                )}
                            </div>
                        )}

                        <DialogFooter>
                            {step === "application" ? (
                                <>
                                    <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                                        {t("common.cancel")}
                                    </Button>
                                    <Button type="submit" dataTestId="domain-steps-next">
                                        {t("domains.steps.next")}
                                    </Button>
                                </>
                            ) : (
                                <>
                                    <Button type="button" variant="secondary" onClick={() => setStep("application")} disabled={busy}>
                                        {t("domains.wizard.back")}
                                    </Button>
                                    <Button type="submit" loading={busy} disabled={busy || (exposure === "remote" && !host)} dataTestId="domain-steps-create">
                                        {t("domains.wizard.create")}
                                    </Button>
                                </>
                            )}
                        </DialogFooter>
                    </form>
                </FormProvider>
            </DialogContent>
        </Dialog>
    )
}

export default DomainStepsWizardDialog
