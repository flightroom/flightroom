import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@flightroom/design-system"
import { useQueries } from "@tanstack/react-query"
import { LayoutDashboard, Server } from "lucide-react"
import { useId } from "react"
import { useTranslation } from "react-i18next"
import RepositoryLink from "@/components/RepositoryLink"
import useCodeRepositoriesApi, { UnifiedBranch } from "@/hooks/apiClients/useCodeRepositoriesApi"
import type { Frontend } from "@/hooks/apiClients/useFrontendsApi"

type CodeRepository = NonNullable<Frontend["codeRepository"]>

/** A repository the agent works on: the one of a frontend or of a backend. */
export interface AiWorkspaceRepository {
    /** The frontend's or the backend's. */
    id: string
    kind: "frontend" | "backend"
    name: string
    codeRepository: CodeRepository
}

/** The branch each repository starts from, by frontend or backend id: one left out starts from its default branch. */
export type BaseBranches = Record<string, string>

/** The repository of a frontend or a backend, as a list: empty when it has none connected. */
export const workspaceRepositoriesOf = (kind: AiWorkspaceRepository["kind"], component: { _id?: string; name: string; codeRepository?: Frontend["codeRepository"] }): AiWorkspaceRepository[] =>
    component._id && component.codeRepository?.enabled ? [{ id: component._id, kind, name: component.name, codeRepository: component.codeRepository }] : []

/** The branches picked, trimmed, of the given repositories only. */
export const pickedBaseBranches = (repositories: AiWorkspaceRepository[], baseBranches: BaseBranches): BaseBranches =>
    Object.fromEntries(repositories.flatMap(({ id }) => (baseBranches[id]?.trim() ? [[id, baseBranches[id].trim()]] : [])))

// What the branches endpoint expects: the project path on GitLab, the repository name elsewhere.
const branchesPath = (repository: CodeRepository) => (repository.gitlab ? repository.repositoryId : repository.name || repository.repositoryId)

// A colon cannot be in a branch name: the item that sends every repository back to its default branch never clashes with one.
const EACH_DEFAULT = ":default"

interface BranchSelectProps {
    repository: AiWorkspaceRepository
    branches?: UnifiedBranch[]
    failed: boolean
    value: string
    onChange: (branch: string) => void
    disabled?: boolean
    explicit?: boolean
}

/** Where one repository starts from: its branches once known, free text when the provider cannot list them. */
const BranchSelect: React.FC<BranchSelectProps> = ({ repository, branches, failed, value, onChange, disabled, explicit }) => {
    const { t } = useTranslation()
    const label = t("frontend.aiChange.base_branch_of", { name: repository.name })

    if (failed) {
        return (
            <Input
                aria-label={label}
                value={value}
                placeholder={t("frontend.aiChange.base_branch_placeholder")}
                disabled={disabled}
                onChange={event => onChange(event.target.value)}
                className="w-48"
                dataTestId="ai-change-base-branch"
            />
        )
    }

    const defaultBranch = branches?.find(branch => branch.default)?.branch
    const names = (branches ?? []).map(branch => branch.branch)
    // A branch brought back by "Try again" stays pickable even when the provider no longer lists it.
    if (value && !names.includes(value)) names.unshift(value)

    return (
        // Unless explicit, the default branch is kept as no choice at all: the server resolves it when the job starts.
        <Select layoutSize="sm" value={value} onValueChange={branch => onChange(branch === defaultBranch && !explicit ? "" : branch)} disabled={disabled || !branches}>
            <SelectTrigger aria-label={label} className="w-48 shrink-0" dataTestId="ai-change-base-branch">
                <SelectValue placeholder={branches ? t("frontend.aiChange.base_branch_default", { branch: defaultBranch ?? "" }) : t("common.loading")} />
            </SelectTrigger>
            <SelectContent>
                {names.map(name => (
                    <SelectItem key={name} value={name}>
                        {name === defaultBranch ? t("frontend.aiChange.base_branch_default", { branch: name }) : name}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    )
}

interface RepositoryBranchesProps {
    repositories: AiWorkspaceRepository[]
    value: BaseBranches
    onChange: (value: BaseBranches) => void
    disabled?: boolean
    /** Every repository keeps the name of its branch, its default one included: for a server that does not resolve the default branch. */
    explicit?: boolean
    /** In place of the hint about the agent's feature branches. */
    hint?: string
}

/**
 * The repositories the agent works on, each linked to its page on the provider, and the branch each starts from.
 * Over several, one choice sets them all: their own default branches, or a branch every one of them has.
 */
export const RepositoryBranches: React.FC<RepositoryBranchesProps> = ({ repositories, value, onChange, disabled, explicit, hint }) => {
    const { t } = useTranslation()
    const { getBranches } = useCodeRepositoriesApi()
    const headingId = useId()

    const branchQueries = useQueries({
        queries: repositories.map(({ codeRepository }) => ({
            queryKey: ["repository-branches", codeRepository.codeRepositoryId, branchesPath(codeRepository)],
            queryFn: () => getBranches(codeRepository.codeRepositoryId, branchesPath(codeRepository)),
            staleTime: 60_000
        }))
    })

    if (repositories.length === 0) return null

    // Offered once every list is known: a branch missing from one repository would fail its job.
    const common = branchQueries.every(query => query.data)
        ? branchQueries.map(query => query.data!.map(branch => branch.branch)).reduce((shared, names) => shared.filter(name => names.includes(name)))
        : []
    const defaults = branchQueries.map(query => query.data?.find(branch => branch.default)?.branch)
    const picked = repositories.map(repository => value[repository.id] ?? "")
    const eachDefault = explicit ? picked.every((branch, index) => branch === defaults[index]) : picked.every(branch => branch === "")
    const sharedValue = picked.every(branch => branch === picked[0]) && common.includes(picked[0]) ? picked[0] : eachDefault ? EACH_DEFAULT : ""
    const toEachDefault = () => (explicit ? Object.fromEntries(repositories.map(({ id }, index) => [id, defaults[index] ?? value[id] ?? ""])) : {})

    return (
        <section className="flex flex-col gap-2" aria-labelledby={headingId}>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id={headingId} className="text-sm font-medium">
                    {t("frontend.aiChange.repositories_title", { count: repositories.length })}
                </h3>
                {repositories.length > 1 && (
                    <Select
                        layoutSize="sm"
                        value={sharedValue}
                        onValueChange={branch => onChange(branch === EACH_DEFAULT ? toEachDefault() : Object.fromEntries(repositories.map(({ id }) => [id, branch])))}
                        disabled={disabled}
                    >
                        <SelectTrigger aria-label={t("frontend.aiChange.base_branch_all")} className="w-60" dataTestId="ai-change-base-branch-all">
                            <SelectValue placeholder={t("frontend.aiChange.base_branch_mixed")} />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={EACH_DEFAULT}>{t("frontend.aiChange.base_branch_each_default")}</SelectItem>
                            {common.map(name => (
                                <SelectItem key={name} value={name}>
                                    {t("frontend.aiChange.base_branch_everywhere", { branch: name })}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                )}
            </div>
            <ul className="flex flex-col gap-2">
                {repositories.map((repository, index) => {
                    const Icon = repository.kind === "backend" ? Server : LayoutDashboard
                    return (
                        <li key={repository.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-divider px-3 py-2 text-sm">
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="flex min-w-0 items-center gap-2 font-medium">
                                    <Icon className="size-4 shrink-0 text-foreground-secondary" aria-hidden="true" />
                                    <span className="truncate">{repository.name}</span>
                                    <span className="sr-only"> ({t(`frontend.aiChange.kind.${repository.kind}`)})</span>
                                </span>
                                <span className="min-w-0 text-xs text-foreground-secondary">
                                    <RepositoryLink repository={repository.codeRepository} />
                                </span>
                            </span>
                            <span className="flex items-center gap-2">
                                <span className="text-xs text-foreground-secondary">{t("frontend.aiChange.starts_from")}</span>
                                <BranchSelect
                                    repository={repository}
                                    branches={branchQueries[index]?.data}
                                    failed={Boolean(branchQueries[index]?.isError && !branchQueries[index]?.data)}
                                    value={value[repository.id] ?? ""}
                                    onChange={branch => onChange({ ...value, [repository.id]: branch })}
                                    disabled={disabled}
                                    explicit={explicit}
                                />
                            </span>
                        </li>
                    )
                })}
            </ul>
            <p className="text-xs text-foreground-secondary">{hint ?? t("frontend.aiChange.base_branch_hint")}</p>
        </section>
    )
}

export default RepositoryBranches
