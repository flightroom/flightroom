import {
    Alert,
    AlertDescription,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "@flightroom/design-system"
import { zodResolver } from "@hookform/resolvers/zod"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, Check, ChevronDown, Circle, Hammer, Loader2, Rocket, Workflow, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { z } from "zod"
import { Badge, Button } from "@/components/atoms"
import TextField from "@/components/input/TextField.rhf"
import EnvironmentSelector from "@/components/molecules/EnvironmentSelector"
import useBuildsApi, { BUILD_STATUS_QUERY_KEY, type ComponentBuildStatus } from "@/hooks/apiClients/useBuildsApi"
import useDomainsApi, { buildCheckOf, type Domain, type DomainBuildResult, type DomainRelease, type DomainReleaseMember, isReleaseRunning } from "@/hooks/apiClients/useDomainsApi"
import { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import { useProjectEnvironmentsQuery } from "@/pages/backends/partials/backendVariables"
import ProviderRunLink from "@/pages/builds/partials/ProviderRunLink"
import useProjectStore, { useIsProjectViewer } from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import { cn } from "@/utils/styleUtils"
import DomainBuildButton, { DomainBuildOutcomes, VERSION } from "./DomainBuildDialog"
import DomainDeployButton from "./DomainDeployDialog"

/** How often a running release is read again */
const POLL_EVERY_MS = 5_000

/** How often the runs of the CI are read again: the backend keeps the build status this long anyway */
const RUNS_EVERY_MS = 15_000

const NO_ENVIRONMENTS: EnvironmentDTO[] = []

const STEPS = ["building", "waiting_ci", "updating_versions", "deploying"] as const

/** The failures told in the console's words: any other keeps the backend's */
const TRANSLATED_ERRORS = [
    "DOMAIN_RELEASE_TAG_FAILED",
    "DOMAIN_RELEASE_CI_TIMEOUT",
    "DOMAIN_RELEASE_CI_FAILED",
    "DOMAIN_RELEASE_CI_NOT_REGISTERED",
    "DOMAIN_RELEASE_INTERRUPTED",
    "DOMAIN_RELEASE_USER_UNAVAILABLE",
    "DOMAIN_BUILD_CHECK_FAILED"
]

const MEMBER_VARIANTS: Record<"untouched" | "waiting" | "built", "success" | "outline" | "default"> = { untouched: "default", waiting: "outline", built: "success" }

const memberState = (member: DomainReleaseMember) => (!member.tagged ? "untouched" : member.built ? "built" : "waiting")

/**
 * Builds and deploys the domain in one go: creates the version as {@link DomainBuildButton} does, then the
 * console waits for the CI of every tagged repository, sets that version on their frontends and backends and
 * deploys the domain to the environment picked. The steps after the build run in the backend: the dialog only
 * follows them, and opened again while a release runs it shows that release instead of the form.
 */
export const DomainBuildAndDeployButton: React.FC<{ domain: Domain }> = ({ domain }) => {
    const { t } = useTranslation()
    const domainsApi = useDomainsApi()
    const projectStore = useProjectStore()
    const queryClient = useQueryClient()
    const notifications = useToastNotificationStore()
    const isViewer = useIsProjectViewer()
    const { getBuildStatus } = useBuildsApi()
    const [open, setOpen] = useState(false)
    const [buildOpen, setBuildOpen] = useState(false)
    const [deployOpen, setDeployOpen] = useState(false)
    const [environment, setEnvironment] = useState<EnvironmentDTO | undefined>()
    /** The refusal of the build's check, repository by repository */
    const [refusal, setRefusal] = useState<DomainBuildResult | undefined>()
    /** The release started or followed here: still shown once over, until the dialog is closed */
    const [followedId, setFollowedId] = useState<string | undefined>()

    // Read here, not from the store: the store has them only once a page under the environments gate was opened
    const environments = useProjectEnvironmentsQuery().data ?? NO_ENVIRONMENTS
    // A pick of an environment deleted since, or of another project, does not stick
    const selected = environments.find(candidate => candidate._id === environment?._id) ?? environments.find(candidate => candidate._id === projectStore.environment?._id) ?? environments[0]
    const queryKey = ["domain-release", domain._id]

    // Read even with the dialog closed: the end of a release is told wherever the domain is open
    const { data: release } = useQuery({
        queryKey,
        queryFn: () => domainsApi.getLatestRelease(domain._id),
        enabled: !isViewer && environments.length > 0,
        refetchInterval: query => (isReleaseRunning(query.state.data) ? POLL_EVERY_MS : false)
    })

    const schema = z.object({
        version: z.string().regex(VERSION, t("domains.build.errors.version_invalid")),
        branch: z.string().max(255)
    })
    const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), mode: "onChange", defaultValues: { version: "", branch: "main" } })
    const submitting = form.formState.isSubmitting

    // Told once, when the release is seen ending: not for one that was over already when the page loaded
    const seen = useRef<{ id: string; status: string } | undefined>(undefined)
    useEffect(() => {
        const before = seen.current
        seen.current = release ? { id: release._id, status: release.status } : undefined
        const ended = release && before?.id === release._id && before.status !== "deployed" && before.status !== "failed" && !isReleaseRunning(release)
        if (!release || !ended) return
        const deployedTo = environments.find(candidate => candidate._id === release.environmentId)?.name
        if (release.status === "deployed") {
            notifications.showSuccessNotification({ message: t("domains.release.success", { domain: domain.name, version: release.version, environment: deployedTo }) })
            void Promise.all([
                queryClient.invalidateQueries({ queryKey: ["deployments", release.environmentId] }),
                queryClient.invalidateQueries({ queryKey: ["domain-deployments"] }),
                queryClient.invalidateQueries({ queryKey: ["domain-deployments-matrix"] })
            ])
        } else {
            notifications.showErrorNotification({ message: t("domains.release.failed", { domain: domain.name, version: release.version }) })
        }
    }, [release, environments, domain.name, notifications, queryClient, t])

    const onSubmit = async (values: z.infer<typeof schema>) => {
        if (!selected?._id) return
        try {
            const started = await domainsApi.startRelease(domain._id, values.version, selected._id, values.branch.trim() || undefined)
            queryClient.setQueryData(queryKey, started)
            setFollowedId(started._id)
            form.reset()
        } catch (error) {
            // The check refused the build: its outcome per repository says why, the toast is already shown
            setRefusal(buildCheckOf(error as Error))
            // A release refused, or one already running, is the latest now: the dialog shows it
            await queryClient.invalidateQueries({ queryKey })
        }
    }

    const changeOpen = (value: boolean) => {
        if (submitting) return
        setOpen(value)
        if (!value) {
            setRefusal(undefined)
            setFollowedId(undefined)
            form.reset()
        }
    }

    const running = isReleaseRunning(release)
    const shown = release && (running || release._id === followedId) ? release : undefined

    // The runs the tag started, to open them on the provider: read only while a release is on screen
    const projectId = projectStore.project?._id
    const { data: buildStatus } = useQuery({
        queryKey: [BUILD_STATUS_QUERY_KEY, projectId],
        queryFn: getBuildStatus,
        enabled: open && Boolean(shown) && Boolean(projectId),
        refetchInterval: running ? RUNS_EVERY_MS : false
    })

    // A viewer may look, not release. Always there for the others: without environments, or before they load, it is disabled
    if (isViewer) return null

    /** The member's row of the build status, with the provider its runs are on */
    const buildsOf = (member: DomainReleaseMember): ComponentBuildStatus | undefined =>
        member.kind === "frontend" ? buildStatus?.frontends.find(row => row.frontendId === member._id) : buildStatus?.backends.find(row => row.backendId === member._id)

    /** The failure in the console's words, naming the members still waiting when it was the CI */
    const errorOf = (failed: DomainRelease) => {
        if (!failed.errorCode || !TRANSLATED_ERRORS.includes(failed.errorCode)) return t("domains.release.errors.generic", { message: failed.errorMessage ?? "" })
        const names = failed.members
            .filter(member => member.tagged && !member.built)
            .map(member => member.name)
            .join(", ")
        return t(`domains.release.errors.${failed.errorCode}`, { version: failed.version, names })
    }

    const progress = (current: DomainRelease) => {
        const failed = current.status === "failed"
        const at = current.status === "deployed" ? STEPS.length : STEPS.indexOf(failed ? (current.failedStep ?? "building") : (current.status as (typeof STEPS)[number]))
        const outcomes = current.repositories.some(repository => repository.status === "failed")
        return (
            <>
                <ol className="mt-2 flex items-center gap-2" data-testid="domain-release-steps">
                    {STEPS.map((step, index) => {
                        const done = index < at
                        const failedHere = failed && index === at
                        const active = index === at && !failed
                        return (
                            <li key={step} className="flex flex-1 items-center gap-2" data-testid={`domain-release-step-${step}`}>
                                <span
                                    className={cn(
                                        "flex size-6 shrink-0 items-center justify-center rounded-full border",
                                        done && "border-primary bg-primary text-primary-foreground",
                                        failedHere && "border-destructive bg-destructive text-destructive-foreground",
                                        active && "border-primary text-primary",
                                        !done && !failedHere && !active && "border-border text-muted-foreground"
                                    )}
                                >
                                    {done ? (
                                        <Check className="size-3.5" />
                                    ) : failedHere ? (
                                        <X className="size-3.5" />
                                    ) : active ? (
                                        <Loader2 className="size-3.5 animate-spin" />
                                    ) : (
                                        <Circle className="size-2.5" />
                                    )}
                                </span>
                                <span className={cn("text-xs", active || failedHere ? "font-medium text-foreground" : "text-foreground-secondary")}>{t(`domains.release.steps.${step}`)}</span>
                            </li>
                        )
                    })}
                </ol>
                {failed && (
                    <Alert variant="destructive" className="mt-3" dataTestId="domain-release-error">
                        <AlertTriangle className="size-4" aria-hidden="true" />
                        <AlertDescription className="whitespace-pre-wrap break-words">{errorOf(current)}</AlertDescription>
                    </Alert>
                )}
                {failed && outcomes ? (
                    <DomainBuildOutcomes result={current} />
                ) : (
                    <ul className="my-4 flex flex-col gap-2" data-testid="domain-release-members">
                        {current.members.map(member => {
                            const row = buildsOf(member)
                            const runs = member.tagged ? (row?.builds.filter(run => run.ref === current.version && run.url) ?? []) : []
                            return (
                                <li key={member._id} className="flex items-center justify-between gap-2 rounded-md border border-divider p-3">
                                    <div className="flex min-w-0 flex-col">
                                        <span className="truncate text-sm">{member.name}</span>
                                        <span className="text-xs text-foreground-secondary">{t(`domains.release.kinds.${member.kind}`)}</span>
                                        {runs.map(run => (
                                            <span key={run.id} className="mt-1" data-testid={`domain-release-run-${member._id}`}>
                                                <ProviderRunLink url={run.url!} provider={row?.provider} />
                                            </span>
                                        ))}
                                    </div>
                                    <Badge variant={MEMBER_VARIANTS[memberState(member)]}>{t(`domains.release.member_status.${memberState(member)}`)}</Badge>
                                </li>
                            )
                        })}
                    </ul>
                )}
                {current.members.some(member => !member.tagged) && <p className="mb-4 text-xs text-foreground-secondary">{t("domains.release.untouched_hint")}</p>}
                {isReleaseRunning(current) && (
                    <p className="mb-4 text-xs text-foreground-secondary" data-testid="domain-release-close-hint">
                        {t("domains.release.close_hint")}
                    </p>
                )}
            </>
        )
    }

    return (
        <>
            <div className="inline-flex">
                <Button onClick={() => setOpen(true)} disabled={environments.length === 0} className="rounded-r-none" dataTestId="domain-build-and-deploy">
                    {running ? <Loader2 className="animate-spin" /> : <Workflow />}
                    {t("domains.release.action")}
                </Button>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button aria-label={t("domains.release.more_actions")} className="h-10 w-10 min-w-10 shrink-0 rounded-l-none px-0" dataTestId="domain-build-and-deploy-menu">
                            <ChevronDown />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setDeployOpen(true)} disabled={environments.length === 0} dataTestId="domain-deploy-menu-item">
                            <Rocket className="mr-2 h-4 w-4" />
                            {t("domains.deploy.action")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setBuildOpen(true)} dataTestId="domain-build-menu-item">
                            <Hammer className="mr-2 h-4 w-4" />
                            {t("domains.build.action")}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
            <DomainDeployButton domain={domain} open={deployOpen} onOpenChange={setDeployOpen} showTrigger={false} />
            <DomainBuildButton domain={domain} open={buildOpen} onOpenChange={setBuildOpen} showTrigger={false} />
            <Dialog open={open} onOpenChange={changeOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("domains.release.title", { domain: domain.name })}</DialogTitle>
                        <DialogDescription>
                            {refusal
                                ? t("domains.build.result_description", { version: refusal.version, ref: refusal.ref })
                                : shown
                                  ? t("domains.release.progress_description", {
                                        version: shown.version,
                                        ref: shown.ref,
                                        environment: environments.find(candidate => candidate._id === shown.environmentId)?.name ?? ""
                                    })
                                  : t("domains.release.description")}
                        </DialogDescription>
                    </DialogHeader>
                    {refusal ? (
                        <>
                            <DomainBuildOutcomes result={refusal} />
                            <DialogFooter>
                                <Button variant="secondary" type="button" onClick={() => setRefusal(undefined)}>
                                    {t("common.back")}
                                </Button>
                                <Button type="button" onClick={() => changeOpen(false)}>
                                    {t("common.close")}
                                </Button>
                            </DialogFooter>
                        </>
                    ) : shown ? (
                        <>
                            {progress(shown)}
                            <DialogFooter>
                                {!running && (
                                    <Button variant="secondary" type="button" onClick={() => setFollowedId(undefined)} dataTestId="domain-release-new">
                                        {t("domains.release.new")}
                                    </Button>
                                )}
                                <Button type="button" onClick={() => changeOpen(false)}>
                                    {t("common.close")}
                                </Button>
                            </DialogFooter>
                        </>
                    ) : (
                        <FormProvider {...form}>
                            <form onSubmit={form.handleSubmit(onSubmit)}>
                                <div className={cn("mt-2 mb-4 space-y-2", submitting && "pointer-events-none opacity-60")}>
                                    <TextField name="version" label={t("domains.build.version")} placeholder={t("backends.build.versionPlaceholder")} required />
                                    <TextField name="branch" label={t("domains.build.branch")} placeholder="main" />
                                    <p className="text-xs text-foreground-secondary">{t("domains.build.branch_hint")}</p>
                                    <div className="pt-2">
                                        <EnvironmentSelector selectedEnvironment={selected} environments={environments} onEnvironmentChange={setEnvironment} />
                                    </div>
                                </div>
                                <DialogFooter>
                                    <Button type="button" variant="secondary" onClick={() => changeOpen(false)} disabled={submitting}>
                                        {t("common.cancel")}
                                    </Button>
                                    <Button
                                        type="submit"
                                        disabled={submitting || !form.formState.isValid || !selected?._id}
                                        loading={submitting}
                                        loadingLabel={t("backends.build.building")}
                                        dataTestId="domain-build-and-deploy-confirm"
                                    >
                                        <Workflow />
                                        {t("domains.release.start")}
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

export default DomainBuildAndDeployButton
