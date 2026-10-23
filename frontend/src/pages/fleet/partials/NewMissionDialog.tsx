import {
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    RadioGroup,
    RadioGroupItem,
    SearchInput,
    Spinner,
    Textarea
} from "@flightroom/design-system"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { LayoutDashboard, Server, Ship } from "lucide-react"
import { useId, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import AiModelSelect from "@/components/assistant/AiModelSelect"
import { PROMPT_MAX_LENGTH } from "@/components/assistant/AssistantJobThread"
import EffortSelect from "@/components/assistant/EffortSelect"
import { useEffort } from "@/components/assistant/useEffort"
import useProjectAiModels from "@/components/assistant/useProjectAiModels"
import { Badge, Button } from "@/components/atoms"
import useAiMissionsApi, { AiMissionMode, MISSION_BATCH_SIZE, MISSION_CONCURRENCY, MISSION_MAX_REPOSITORIES } from "@/hooks/apiClients/useAiMissionsApi"
import useDomainsApi from "@/hooks/apiClients/useDomainsApi"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import { cn } from "@/utils/styleUtils"
import { missionErrorMessage } from "./missionShared"

const MODES: AiMissionMode[] = ["global", "perRepository"]
const NO_DOMAIN = "no-domain"

interface Repository {
    kind: "frontend" | "service"
    id: string
    name: string
}

interface RepositoryGroup {
    id: string
    name: string
    repositories: Repository[]
}

interface NewMissionFormProps {
    projectId: string
    onDone: () => void
}

/** Lives inside the dialog content, so closing the dialog starts the next mission from a blank form. */
const NewMissionForm: React.FC<NewMissionFormProps> = ({ projectId, onDone }) => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const notifications = useToastNotificationStore()
    const aiMissionsApi = useAiMissionsApi()
    const domainsApi = useDomainsApi()
    const [prompt, setPrompt] = useState("")
    const [mode, setMode] = useState<AiMissionMode>("global")
    const [all, setAll] = useState(false)
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [search, setSearch] = useState("")
    const [concurrency, setConcurrency] = useState(String(MISSION_CONCURRENCY.default))
    const [submitted, setSubmitted] = useState(false)
    const [effort, setEffort] = useEffort("code")
    const { selected: aiModel, setSelected: setAiModel } = useProjectAiModels()
    const promptRef = useRef<HTMLTextAreaElement>(null)
    const idPrefix = useId()

    // Decided by the backend, as it checks the start: a repository the agents can open, in the caller's domains.
    const optionsQuery = useQuery({
        queryKey: ["ai-missions-repositories", projectId],
        queryFn: () => aiMissionsApi.repositories({ customErrorMessage: error => missionErrorMessage(t, error, "load") })
    })
    const domainsQuery = useQuery({ queryKey: ["domains", projectId], queryFn: domainsApi.getAll })
    const isPending = optionsQuery.isPending || domainsQuery.isPending
    // A member assigned to some domains picks among them: never every repository of the project at once.
    const canPickAll = optionsQuery.data?.all ?? false

    const { repositories, groups } = useMemo(() => {
        const members = optionsQuery.data?.repositories ?? []
        const domains = domainsQuery.data ?? []
        const domainIds = new Set(domains.map(domain => domain._id))
        const groupOf = (domainId?: string | null) => (domainId && domainIds.has(domainId) ? domainId : NO_DOMAIN)
        const byName = (a: Repository, b: Repository) => a.name.localeCompare(b.name)
        const toRepository = ({ kind, id, name }: (typeof members)[number]): Repository => ({ kind, id, name })
        const groups: RepositoryGroup[] = [
            ...domains.map(domain => ({
                id: domain._id,
                name: domain.name,
                repositories: members
                    .filter(member => groupOf(member.domainId) === domain._id)
                    .map(toRepository)
                    .sort(byName)
            })),
            {
                id: NO_DOMAIN,
                name: t("domains.no_domain"),
                repositories: members
                    .filter(member => groupOf(member.domainId) === NO_DOMAIN)
                    .map(toRepository)
                    .sort(byName)
            }
        ].filter(group => group.repositories.length > 0)
        return { repositories: members.map(toRepository), groups }
    }, [optionsQuery.data, domainsQuery.data, t])

    const term = search.trim().toLowerCase()
    const visibleGroups = term
        ? groups.map(group => ({ ...group, repositories: group.repositories.filter(repository => repository.name.toLowerCase().includes(term)) })).filter(group => group.repositories.length > 0)
        : groups

    const pickAll = all && canPickAll
    const count = pickAll ? repositories.length : selected.size
    const batches = Math.ceil(count / MISSION_BATCH_SIZE)
    const concurrencyValue = Number(concurrency)
    const concurrencyValid = Number.isInteger(concurrencyValue) && concurrencyValue >= MISSION_CONCURRENCY.min && concurrencyValue <= MISSION_CONCURRENCY.max
    // Ids are unique across frontends and services: the kind only decides which list an id goes in.
    const selectedOf = (kind: Repository["kind"]) => repositories.filter(repository => repository.kind === kind && selected.has(repository.id)).map(repository => repository.id)

    const createMutation = useMutation({
        mutationFn: () =>
            aiMissionsApi.create(
                {
                    prompt: prompt.trim(),
                    mode,
                    ...(pickAll ? { all: true } : { frontendIds: selectedOf("frontend"), serviceIds: selectedOf("service") }),
                    ...(mode === "perRepository" ? { concurrency: concurrencyValue } : {}),
                    effort,
                    aiModelId: aiModel?.id
                },
                { customErrorMessage: error => missionErrorMessage(t, error, "create") }
            ),
        onSuccess: mission => {
            queryClient.invalidateQueries({ queryKey: ["ai-missions"] })
            notifications.showSuccessNotification({ message: t("fleet.new.started") })
            onDone()
            navigate(`/fleet/${mission._id}`)
        }
    })

    const promptError = submitted && !prompt.trim() ? t("fleet.new.prompt_required") : undefined
    let selectionError: string | undefined
    if (count > MISSION_MAX_REPOSITORIES) selectionError = t("fleet.new.too_many", { count, max: MISSION_MAX_REPOSITORIES })
    else if (submitted && count === 0) selectionError = t("fleet.new.selection_required")
    const concurrencyError = mode === "perRepository" && !concurrencyValid ? t("fleet.new.concurrency_invalid", MISSION_CONCURRENCY) : undefined

    const setChecked = (ids: string[], checked: boolean) =>
        setSelected(current => {
            const next = new Set(current)
            for (const id of ids) {
                if (checked) next.add(id)
                else next.delete(id)
            }
            return next
        })

    const start = () => {
        setSubmitted(true)
        if (!prompt.trim()) {
            promptRef.current?.focus()
            return
        }
        if (count === 0 || count > MISSION_MAX_REPOSITORIES || concurrencyError) return
        createMutation.mutate()
    }

    const busy = createMutation.isPending
    const promptId = `${idPrefix}-prompt`
    const allId = `${idPrefix}-all`
    const concurrencyId = `${idPrefix}-concurrency`
    const selectionHintId = `${idPrefix}-selection-hint`

    let batchHint: string | undefined
    if (count > MISSION_BATCH_SIZE) batchHint = t(mode === "global" ? "fleet.new.batches_global" : "fleet.new.batches_per_repository", { size: MISSION_BATCH_SIZE, batches })

    return (
        <form
            className="flex min-w-0 flex-col gap-4"
            onSubmit={event => {
                event.preventDefault()
                start()
            }}
        >
            <div className="flex flex-col gap-1.5">
                <Label htmlFor={promptId}>
                    {t("fleet.new.prompt_label")}
                    <span aria-hidden="true"> *</span>
                </Label>
                <Textarea
                    id={promptId}
                    ref={promptRef}
                    value={prompt}
                    rows={4}
                    maxLength={PROMPT_MAX_LENGTH}
                    aria-required="true"
                    aria-invalid={Boolean(promptError)}
                    aria-describedby={`${promptId}-hint`}
                    placeholder={t("fleet.new.prompt_placeholder")}
                    disabled={busy}
                    onChange={event => setPrompt(event.target.value)}
                    dataTestId="fleet-new-mission-prompt"
                />
                <p id={`${promptId}-hint`} className="text-xs text-destructive">
                    {promptError}
                </p>
            </div>

            <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-sm font-medium">{t("fleet.new.mode_label")}</legend>
                <RadioGroup value={mode} onValueChange={value => setMode(value as AiMissionMode)} disabled={busy} className="flex flex-wrap gap-3">
                    {MODES.map(option => (
                        <label
                            key={option}
                            htmlFor={`${idPrefix}-mode-${option}`}
                            className={cn(
                                "flex flex-[1_1_220px] cursor-pointer items-start gap-3 rounded-md border-2 border-border p-3 transition-colors",
                                mode === option && "border-primary bg-primary/5",
                                busy && "cursor-not-allowed opacity-60"
                            )}
                        >
                            <RadioGroupItem id={`${idPrefix}-mode-${option}`} value={option} className="mt-0.5" dataTestId={`fleet-new-mission-mode-${option}`} />
                            <span className="min-w-0">
                                <span className="block text-sm font-semibold">{t(`fleet.mode.${option}`)}</span>
                                <span className="block text-xs text-foreground-secondary">{t(`fleet.mode.${option}_description`)}</span>
                            </span>
                        </label>
                    ))}
                </RadioGroup>
            </fieldset>

            <fieldset className="flex min-w-0 flex-col gap-2" aria-describedby={selectionHintId}>
                <legend className="mb-2 text-sm font-medium">{t("fleet.new.repositories_label")}</legend>
                {canPickAll && (
                    <div className="flex items-center gap-2">
                        <Checkbox id={allId} checked={all} disabled={busy} onCheckedChange={checked => setAll(checked === true)} dataTestId="fleet-new-mission-all" />
                        <Label htmlFor={allId} className="cursor-pointer">
                            {t("fleet.new.all", { count: repositories.length })}
                        </Label>
                    </div>
                )}
                {isPending && <Spinner size={20} centerScreen={false} label={t("common.loading")} />}
                {!isPending && repositories.length === 0 && <p className="text-sm text-foreground-secondary">{t("assistant.jobs.new.no_repositories")}</p>}
                {!pickAll && repositories.length > 0 && (
                    <>
                        <SearchInput
                            value={search}
                            onValueChange={setSearch}
                            onClear={() => setSearch("")}
                            clearLabel={t("fleet.new.search_clear")}
                            placeholder={t("fleet.new.search_placeholder")}
                            aria-label={t("fleet.new.search_placeholder")}
                            disabled={busy}
                            fullWidth
                        />
                        <div className="flex max-h-72 flex-col gap-3 overflow-y-auto rounded-md border border-divider p-3">
                            {visibleGroups.length === 0 && <p className="text-sm text-foreground-secondary">{t("fleet.new.no_results")}</p>}
                            {visibleGroups.map(group => {
                                const ids = group.repositories.map(repository => repository.id)
                                const checkedCount = ids.filter(id => selected.has(id)).length
                                const groupId = `${idPrefix}-group-${group.id}`
                                return (
                                    <div key={group.id} role="group" aria-labelledby={`${groupId}-label`} className="flex flex-col gap-2">
                                        <div className="flex items-center gap-2 border-b border-divider pb-1.5">
                                            <Checkbox
                                                id={groupId}
                                                checked={checkedCount === 0 ? false : checkedCount === ids.length ? true : "indeterminate"}
                                                disabled={busy}
                                                aria-label={t("fleet.new.select_group", { name: group.name })}
                                                onCheckedChange={() => setChecked(ids, checkedCount < ids.length)}
                                            />
                                            <Label id={`${groupId}-label`} htmlFor={groupId} className="min-w-0 flex-1 cursor-pointer truncate font-semibold">
                                                {group.name}
                                            </Label>
                                            <span className="shrink-0 text-xs tabular-nums text-foreground-secondary">
                                                {checkedCount}/{ids.length}
                                            </span>
                                        </div>
                                        <ul className="flex flex-col gap-2 pl-2">
                                            {group.repositories.map(repository => {
                                                const checkboxId = `${idPrefix}-${repository.kind}-${repository.id}`
                                                const Icon = repository.kind === "service" ? Server : LayoutDashboard
                                                return (
                                                    <li key={repository.id} className="flex min-w-0 items-center gap-2">
                                                        <Checkbox
                                                            id={checkboxId}
                                                            checked={selected.has(repository.id)}
                                                            disabled={busy}
                                                            onCheckedChange={checked => setChecked([repository.id], checked === true)}
                                                        />
                                                        <Icon className="size-4 shrink-0 text-foreground-secondary" aria-hidden="true" />
                                                        <Label htmlFor={checkboxId} className="min-w-0 flex-1 cursor-pointer truncate">
                                                            {repository.name}
                                                        </Label>
                                                        {repository.kind === "service" && <Badge variant="outline">{t("assistant.jobs.service_badge")}</Badge>}
                                                    </li>
                                                )
                                            })}
                                        </ul>
                                    </div>
                                )
                            })}
                        </div>
                    </>
                )}
                <p id={selectionHintId} className={cn("text-xs", selectionError ? "text-destructive" : "text-foreground-secondary")} aria-live="polite">
                    {selectionError ?? t("fleet.new.selected_count", { count, max: MISSION_MAX_REPOSITORIES })}
                </p>
                {batchHint && <p className="text-xs text-foreground-secondary">{batchHint}</p>}
            </fieldset>

            {mode === "perRepository" && (
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor={concurrencyId}>{t("fleet.new.concurrency_label")}</Label>
                    <Input
                        id={concurrencyId}
                        type="number"
                        inputMode="numeric"
                        min={MISSION_CONCURRENCY.min}
                        max={MISSION_CONCURRENCY.max}
                        step={1}
                        value={concurrency}
                        disabled={busy}
                        aria-invalid={Boolean(concurrencyError)}
                        aria-describedby={`${concurrencyId}-hint`}
                        className="max-w-28"
                        onChange={event => setConcurrency(event.target.value)}
                        dataTestId="fleet-new-mission-concurrency"
                    />
                    <p id={`${concurrencyId}-hint`} className={cn("text-xs", concurrencyError ? "text-destructive" : "text-foreground-secondary")}>
                        {concurrencyError ?? t("fleet.new.concurrency_hint", MISSION_CONCURRENCY)}
                    </p>
                </div>
            )}

            <DialogFooter className="flex-wrap gap-2">
                <div className="mr-auto flex flex-wrap items-center gap-2">
                    <AiModelSelect value={aiModel?.id} onChange={setAiModel} disabled={busy} dataTestId="fleet-new-mission-ai-model" />
                    <EffortSelect value={effort} onChange={setEffort} disabled={busy} dataTestId="fleet-new-mission-effort" />
                </div>
                <Button type="button" variant="secondary" disabled={busy} onClick={onDone}>
                    {t("common.cancel")}
                </Button>
                <Button type="submit" disabled={busy} dataTestId="fleet-new-mission-start">
                    {busy ? <Spinner size={16} centerScreen={false} /> : <Ship aria-hidden="true" />}
                    {t("fleet.new.start")}
                </Button>
            </DialogFooter>
        </form>
    )
}

interface NewMissionDialogProps {
    projectId: string
    open: boolean
    onOpenChange: (open: boolean) => void
}

/** Starts a mission: the same request on many repositories, in batches of ten run one after the other. */
const NewMissionDialog: React.FC<NewMissionDialogProps> = ({ projectId, open, onOpenChange }) => {
    const { t } = useTranslation()
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent closeLabel={t("common.close")} className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" dataTestId="fleet-new-mission-dialog">
                <DialogHeader>
                    <DialogTitle>{t("fleet.new.title")}</DialogTitle>
                    <DialogDescription>{t("fleet.new.description")}</DialogDescription>
                </DialogHeader>
                <NewMissionForm projectId={projectId} onDone={() => onOpenChange(false)} />
            </DialogContent>
        </Dialog>
    )
}

export default NewMissionDialog
