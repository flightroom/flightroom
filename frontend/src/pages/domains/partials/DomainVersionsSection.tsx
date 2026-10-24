import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@flightroom/design-system"
import { zodResolver } from "@hookform/resolvers/zod"
import { useQueries, useQueryClient } from "@tanstack/react-query"
import { LayoutDashboard, Save, Server } from "lucide-react"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { z } from "zod"
import { Button } from "@/components/atoms"
import TextField from "@/components/input/TextField.rhf"
import useBackendsApi, { type Backend, type BuiltBackend } from "@/hooks/apiClients/useBackendsApi"
import useFrontendsApi, { type Frontend, FrontendKind } from "@/hooks/apiClients/useFrontendsApi"
import useProjectStore, { useIsProjectViewer } from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import { VERSION } from "./DomainBuildDialog"

/** A frontend or a backend of the domain, with the version the next deploy ships */
interface Member {
    kind: "frontend" | "backend"
    _id: string
    name: string
    version: string
    /** BUNDLE frontends serve an uploaded bundle; DOCKER frontends and backends the tag of an image */
    bundle: boolean
}

/** The form field of a member: the kind is in the key, a frontend and a backend may not share an id but are never mixed up */
const fieldOf = (member: Pick<Member, "kind" | "_id">) => `${member.kind}-${member._id}`

/**
 * The version of every frontend and backend of the domain, set by hand in one place: the version the
 * deploy of the domain ships. Only the versions changed here are saved; one typed for all fills every row.
 */
export const DomainVersionsSection: React.FC<{ frontends: Frontend[]; backends: Backend[] }> = ({ frontends, backends }) => {
    const { t } = useTranslation()
    const frontendsApi = useFrontendsApi()
    const backendsApi = useBackendsApi()
    const queryClient = useQueryClient()
    const notifications = useToastNotificationStore()
    const projectId = useProjectStore(state => state.project?._id)
    const isViewer = useIsProjectViewer()

    const members: Member[] = [
        ...frontends.map(frontend => ({ kind: "frontend" as const, _id: frontend._id!, name: frontend.name, version: frontend.version ?? "", bundle: frontend.kind !== FrontendKind.DOCKER })),
        ...backends.map(backend => ({ kind: "backend" as const, _id: backend._id!, name: backend.name, version: backend.version ?? "", bundle: false }))
    ]

    // The versions already registered, offered as suggestions: the same queries as the pages of each member
    const registered = useQueries({
        queries: members.map(member =>
            member.kind === "frontend"
                ? { queryKey: ["versions", member._id], queryFn: () => frontendsApi.getVersions(member._id) }
                : // The backend page caches the whole registrations under this key: only the versions are read out of them
                  { queryKey: ["backend-versions", member._id], queryFn: () => backendsApi.getVersions(member._id), select: (built: BuiltBackend[]) => built.map(entry => entry.version) }
        )
    })

    const invalid = t("domains.build.errors.version_invalid")
    const schema = z.object({
        // Left empty, a member keeps its version: a DOCKER may have none until its pipeline registers one
        versions: z.record(
            z.string(),
            z
                .string()
                .trim()
                .refine(value => value === "" || VERSION.test(value), invalid)
        ),
        all: z
            .string()
            .trim()
            .refine(value => value === "" || VERSION.test(value), invalid)
    })
    type Values = z.infer<typeof schema>
    const values: Values = { versions: Object.fromEntries(members.map(member => [fieldOf(member), member.version])), all: "" }
    // Follows the members as they are read again, keeping the rows being edited
    const form = useForm<Values>({ resolver: zodResolver(schema), mode: "onChange", values, resetOptions: { keepDirtyValues: true } })
    const { isSubmitting } = form.formState
    const all = form.watch("all")?.trim() ?? ""
    const edited = form.watch("versions") ?? {}
    const changed = members.filter(member => {
        const next = edited[fieldOf(member)]?.trim() ?? ""
        return next !== "" && next !== member.version
    })

    const applyToAll = () => {
        if (!VERSION.test(all)) return
        for (const member of members) form.setValue(`versions.${fieldOf(member)}`, all, { shouldDirty: true, shouldValidate: true })
        form.setValue("all", "")
    }

    const onSubmit = async (data: Values) => {
        const updates = changed.map(member => {
            const version = data.versions[fieldOf(member)].trim()
            return member.kind === "frontend" ? frontendsApi.update(member._id, { version }) : backendsApi.update(member._id, { version })
        })
        // Each request tells its own failure: the others are saved anyway
        const results = await Promise.allSettled(updates)
        const saved = results.filter(result => result.status === "fulfilled").length
        if (saved > 0) notifications.showSuccessNotification({ message: t("domains.settings.versions_saved", { count: saved }) })
        // What was saved is the new starting point, set before the members are read again: a row left dirty would
        // no longer follow its version, and a later save would put back the one typed here. A row that failed stays edited
        const next: Values = { all: "", versions: { ...form.getValues("versions") } }
        changed.forEach((member, index) => {
            if (results[index].status === "rejected") next.versions[fieldOf(member)] = member.version
        })
        form.reset(next, { keepValues: true })
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["frontends-by-project-id", projectId] }),
            queryClient.invalidateQueries({ queryKey: ["backends", projectId] }),
            // The pages of a frontend read it as "mfe", those of a backend as "backend"
            ...changed.map(member => queryClient.invalidateQueries({ queryKey: [member.kind === "frontend" ? "mfe" : "backend", member._id] }))
        ])
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("domains.settings.versions_title")}</CardTitle>
                <CardDescription>{t("domains.settings.versions_description")}</CardDescription>
            </CardHeader>
            <CardContent className="pt-3">
                {members.length === 0 ? (
                    <p className="text-sm text-foreground-secondary">{t("domains.deployments.no_members_short")}</p>
                ) : (
                    <FormProvider {...form}>
                        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
                            {!isViewer && (
                                <div className="flex flex-wrap items-end gap-x-4 gap-y-2 rounded-md border border-divider bg-muted/40 p-3">
                                    <TextField
                                        name="all"
                                        label={t("domains.settings.version_all")}
                                        placeholder={t("backends.build.versionPlaceholder")}
                                        description={t("domains.settings.version_all_hint")}
                                        containerClassName="flex-[1_1_240px]"
                                        onKeyDown={event => {
                                            // Enter fills the rows, it does not save them
                                            if (event.key === "Enter") {
                                                event.preventDefault()
                                                applyToAll()
                                            }
                                        }}
                                        dataTestId="domain-version-all"
                                    />
                                    <Button type="button" variant="secondary" onClick={applyToAll} disabled={!VERSION.test(all)} dataTestId="domain-version-all-apply">
                                        {t("domains.settings.version_all_apply")}
                                    </Button>
                                </div>
                            )}
                            <ul className="flex flex-col divide-y divide-divider rounded-md border border-divider" data-testid="domain-versions">
                                {members.map((member, index) => {
                                    const Icon = member.kind === "frontend" ? LayoutDashboard : Server
                                    const suggestions = registered[index]?.data ?? []
                                    const listId = `domain-versions-${fieldOf(member)}`
                                    return (
                                        <li key={fieldOf(member)} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3">
                                            <div className="flex min-w-0 flex-col">
                                                <span className="flex items-center gap-1.5 text-sm">
                                                    <Icon className="size-3.5 shrink-0 text-foreground-secondary" aria-hidden="true" />
                                                    <Link to={`/${member.kind}/${member._id}`} className="truncate font-medium hover:underline">
                                                        {member.name}
                                                    </Link>
                                                </span>
                                                <span className="text-xs text-foreground-secondary">
                                                    {t(
                                                        member.kind === "frontend" ? (member.bundle ? "domains.settings.kind_bundle" : "domains.settings.kind_docker") : "domains.release.kinds.backend"
                                                    )}
                                                    {" · "}
                                                    {member.version ? t("domains.settings.current_version", { version: member.version }) : t("domains.settings.no_version")}
                                                </span>
                                            </div>
                                            <TextField
                                                name={`versions.${fieldOf(member)}`}
                                                label={t("frontend.version")}
                                                placeholder={t("backends.build.versionPlaceholder")}
                                                list={suggestions.length > 0 ? listId : undefined}
                                                disabled={isViewer}
                                                containerClassName="w-full sm:w-56"
                                                dataTestId={`domain-version-${fieldOf(member)}`}
                                            />
                                            {suggestions.length > 0 && (
                                                <datalist id={listId}>
                                                    {suggestions.map(version => (
                                                        <option key={version} value={version} />
                                                    ))}
                                                </datalist>
                                            )}
                                        </li>
                                    )
                                })}
                            </ul>
                            {!isViewer && (
                                <div className="flex items-center justify-end gap-3">
                                    {changed.length > 0 && <span className="text-xs text-foreground-secondary">{t("domains.settings.versions_changed", { count: changed.length })}</span>}
                                    <Button type="submit" disabled={changed.length === 0 || isSubmitting} loading={isSubmitting} dataTestId="domain-versions-save">
                                        <Save />
                                        {t("domains.settings.versions_save")}
                                    </Button>
                                </div>
                            )}
                        </form>
                    </FormProvider>
                )}
            </CardContent>
        </Card>
    )
}

export default DomainVersionsSection
