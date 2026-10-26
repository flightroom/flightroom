import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Label
} from "@flightroom/design-system"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, X } from "lucide-react"
import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { Badge, Button } from "@/components/atoms"
import type { Backend } from "@/hooks/apiClients/useBackendsApi"
import useDomainsApi, { type Domain } from "@/hooks/apiClients/useDomainsApi"
import type { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import useProjectStore, { useIsProjectViewer } from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"

type MemberKind = "frontend" | "backend"

interface Member {
    kind: MemberKind
    id: string
    name: string
    slug: string
    domainId?: string | null
}

const membersOf = (frontends: Frontend[], backends: Backend[]): Member[] => [
    ...frontends.flatMap(frontend => (frontend._id ? [{ kind: "frontend" as const, id: frontend._id, name: frontend.name, slug: frontend.slug, domainId: frontend.domainId }] : [])),
    ...backends.flatMap(backend => (backend._id ? [{ kind: "backend" as const, id: backend._id, name: backend.name, slug: backend.slug, domainId: backend.domainId }] : []))
]

const toMembersDTO = (members: Member[]) => ({
    frontendIds: members.filter(member => member.kind === "frontend").map(member => member.id),
    backendIds: members.filter(member => member.kind === "backend").map(member => member.id)
})

/** What changes the members of a domain changes the lists of every page that shows them */
const useInvalidateMembers = () => {
    const queryClient = useQueryClient()
    return () => Promise.all([["frontends-by-project-id"], ["frontends"], ["backends"], ["domains"], ["domain"]].map(queryKey => queryClient.invalidateQueries({ queryKey })))
}

interface AddMembersDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    domain: Domain
    candidates: Member[]
    domains: Domain[]
}

/** Puts frontends and backends of the project in the domain: one already in another domain moves out of it */
const AddMembersDialog: React.FC<AddMembersDialogProps> = ({ open, onOpenChange, domain, candidates, domains }) => {
    const { t } = useTranslation()
    const domainsApi = useDomainsApi()
    const notifications = useToastNotificationStore()
    const invalidate = useInvalidateMembers()
    const idPrefix = useId()
    const [selected, setSelected] = useState<string[]>([])
    const [saving, setSaving] = useState(false)

    const chosen = candidates.filter(member => selected.includes(member.id))
    const domainName = (id?: string | null) => domains.find(candidate => candidate._id === id)?.name

    const changeOpen = (value: boolean) => {
        if (saving) return
        onOpenChange(value)
        if (!value) setSelected([])
    }

    const onSubmit = async (event: React.FormEvent) => {
        event.preventDefault()
        if (chosen.length === 0) return
        setSaving(true)
        try {
            await domainsApi.addMembers(domain._id, toMembersDTO(chosen))
            notifications.showSuccessNotification({ message: t("domains.members.add.success", { count: chosen.length, domain: domain.name }) })
            setSaving(false)
            changeOpen(false)
        } catch {
            setSaving(false)
        } finally {
            await invalidate()
        }
    }

    const groups: { kind: MemberKind; title: string }[] = [
        { kind: "frontend", title: t("domains.members.frontends") },
        { kind: "backend", title: t("domains.members.backends") }
    ]

    return (
        <Dialog open={open} onOpenChange={changeOpen}>
            <DialogContent>
                <form onSubmit={onSubmit}>
                    <DialogHeader>
                        <DialogTitle>{t("domains.members.add.title", { domain: domain.name })}</DialogTitle>
                        <DialogDescription>{t("domains.members.add.description")}</DialogDescription>
                    </DialogHeader>
                    {candidates.length === 0 ? (
                        <p className="my-4 text-sm text-foreground-secondary">{t("domains.members.add.none")}</p>
                    ) : (
                        <div className="my-4 flex max-h-[50vh] flex-col gap-4 overflow-y-auto">
                            {groups.map(({ kind, title }) => {
                                const members = candidates.filter(member => member.kind === kind)
                                if (members.length === 0) return null
                                return (
                                    <fieldset key={kind} className="flex flex-col gap-2">
                                        <legend className="mb-2 text-sm font-medium">{title}</legend>
                                        {members.map(member => {
                                            const checkboxId = `${idPrefix}-${member.id}`
                                            const current = domainName(member.domainId)
                                            return (
                                                <div key={member.id} className="flex items-center gap-2">
                                                    <Checkbox
                                                        id={checkboxId}
                                                        checked={selected.includes(member.id)}
                                                        disabled={saving}
                                                        onCheckedChange={checked => setSelected(list => (checked === true ? [...list, member.id] : list.filter(id => id !== member.id)))}
                                                        dataTestId={`domain-add-member-${member.kind}-${member.slug}`}
                                                    />
                                                    <Label htmlFor={checkboxId} className="min-w-0 flex-1 cursor-pointer truncate">
                                                        {member.name}
                                                    </Label>
                                                    <Badge variant="outline">{current ? t("domains.members.add.in_domain", { domain: current }) : t("domains.members.add.no_domain")}</Badge>
                                                </div>
                                            )
                                        })}
                                    </fieldset>
                                )
                            })}
                        </div>
                    )}
                    <DialogFooter>
                        <Button type="button" variant="secondary" onClick={() => changeOpen(false)} disabled={saving}>
                            {t("common.cancel")}
                        </Button>
                        <Button type="submit" disabled={saving || chosen.length === 0} loading={saving} dataTestId="domain-add-members-confirm">
                            {t("domains.members.add.confirm", { count: chosen.length })}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    )
}

interface DomainMembersSectionProps {
    domain: Domain
    /** Every frontend and backend of the project: those of the domain are listed, the others can be added */
    frontends: Frontend[]
    backends: Backend[]
}

/**
 * The frontends and backends the domain groups, with the way to add others of the project and to take one out: it
 * stays in the project, in no domain. Moving members changes who a domain-scoped member reaches, so only who
 * reaches the whole project changes them.
 */
export const DomainMembersSection: React.FC<DomainMembersSectionProps> = ({ domain, frontends, backends }) => {
    const { t } = useTranslation()
    const domainsApi = useDomainsApi()
    const notifications = useToastNotificationStore()
    const invalidate = useInvalidateMembers()
    const projectId = useProjectStore(state => state.project?._id)
    const domainScoped = useProjectStore(state => Boolean(state.project?.domainScoped))
    const isViewer = useIsProjectViewer()
    const canEdit = !isViewer && !domainScoped
    const [addOpen, setAddOpen] = useState(false)
    const [removing, setRemoving] = useState<string>()

    const domainsQuery = useQuery({ queryKey: ["domains", projectId], queryFn: domainsApi.getAll, enabled: !!projectId && canEdit })

    const all = membersOf(frontends, backends)
    const members = all.filter(member => member.domainId === domain._id)
    const candidates = all.filter(member => member.domainId !== domain._id)

    const remove = async (member: Member) => {
        setRemoving(member.id)
        try {
            await domainsApi.removeMembers(domain._id, toMembersDTO([member]))
            notifications.showSuccessNotification({ message: t("domains.members.remove.success", { name: member.name, domain: domain.name }) })
        } finally {
            setRemoving(undefined)
            await invalidate()
        }
    }

    const groups: { kind: MemberKind; title: string; path: (id: string) => string }[] = [
        { kind: "frontend", title: t("domains.members.frontends"), path: id => `/frontend/${id}/overview` },
        { kind: "backend", title: t("domains.members.backends"), path: id => `/backend/${id}/overview` }
    ]

    return (
        <Card>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
                <div className="flex flex-col gap-1.5">
                    <CardTitle className="mb-0">{t("domains.members.title")}</CardTitle>
                    <CardDescription>{t("domains.members.description")}</CardDescription>
                </div>
                {canEdit && (
                    <Button variant="secondary" onClick={() => setAddOpen(true)} dataTestId="domain-add-members">
                        <Plus />
                        {t("domains.members.add.action")}
                    </Button>
                )}
            </CardHeader>
            <CardContent className="grid gap-6 pt-3 md:grid-cols-2">
                {groups.map(({ kind, title, path }) => {
                    const ofKind = members.filter(member => member.kind === kind)
                    return (
                        <section key={kind} className="flex flex-col gap-2" data-testid={`domain-members-${kind}s`}>
                            <h3 className="text-sm font-semibold">{title}</h3>
                            {ofKind.length === 0 ? (
                                <p className="text-sm text-foreground-secondary">{t(`domains.members.none_${kind}s`)}</p>
                            ) : (
                                <ul className="flex flex-col divide-y divide-divider">
                                    {ofKind.map(member => (
                                        <li key={member.id} className="flex items-center gap-2 py-1.5">
                                            <Link to={path(member.id)} className="min-w-0 flex-1 truncate text-sm underline-offset-4 hover:underline">
                                                {member.name}
                                            </Link>
                                            {canEdit && (
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="icon-sm"
                                                    disabled={removing !== undefined}
                                                    loading={removing === member.id}
                                                    aria-label={t("domains.members.remove.action", { name: member.name })}
                                                    title={t("domains.members.remove.action", { name: member.name })}
                                                    onClick={() => remove(member)}
                                                    dataTestId={`domain-remove-member-${member.kind}-${member.slug}`}
                                                >
                                                    <X />
                                                </Button>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>
                    )
                })}
            </CardContent>
            {canEdit && <AddMembersDialog open={addOpen} onOpenChange={setAddOpen} domain={domain} candidates={candidates} domains={domainsQuery.data ?? []} />}
        </Card>
    )
}

export default DomainMembersSection
