import {
    Alert,
    AlertDescription,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    Label,
    RadioGroup,
    RadioGroupItem,
    SelectField,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow
} from "@flightroom/design-system"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Database, Link2, Link2Off, PlusCircle, Trash2, TriangleAlert } from "lucide-react"
import React, { useId, useState } from "react"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Badge, Button } from "@/components/atoms"
import TextField from "@/components/input/TextField.rhf"
import useDatabaseApi, { Database as ConnectedDatabase, PROVISIONED_DATABASE_NAME, ProvisionedDatabase, ProvisionedDatabaseDeleteMode } from "@/hooks/apiClients/useDatabaseApi"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import type { Resource } from "@/hooks/apiClients/useResourcesApi"
import { useIsProjectViewer } from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import { useProjectEnvironmentsQuery } from "../../backends/partials/backendVariables"
import { useResourcesQuery } from "../../resources/partials/resources"

/** Le risorse che un database creato puo' alimentare: mongodb per stringa di connessione, come richiede il backend */
const isLinkable = (resource: Resource) => resource.type === "mongodb" && resource.variant === "connectionString"

/** Il nome suggerito per il database di una risorsa in un ambiente: `<risorsa>_<ambiente>`, nei caratteri che il nome accetta */
const suggestedName = (resource?: Resource, environment?: EnvironmentDTO) =>
    resource && environment
        ? `${resource.name}_${environment.slug}`
              .toLowerCase()
              .replace(/[^a-z0-9_-]/g, "_")
              .slice(0, 63)
        : ""

/** Le query da rileggere quando un database cambia: i suoi elenchi e le risorse di cui scrive i valori */
const useRefreshDatabases = (serverId: string) => {
    const queryClient = useQueryClient()
    return async () => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["database-provisioned", serverId] }),
            queryClient.invalidateQueries({ queryKey: ["provisioned-databases"] }),
            queryClient.invalidateQueries({ queryKey: ["resources"] }),
            queryClient.invalidateQueries({ queryKey: ["resource"] })
        ])
    }
}

interface LinkFields {
    resourceId: string
    environmentId: string
}

/** La risorsa e l'ambiente da alimentare: due select, obbligatorie solo quando `required` */
const LinkSelects: React.FC<{ resources: Resource[]; environments: EnvironmentDTO[]; required: boolean; onChange?: () => void }> = ({ resources, environments, required, onChange }) => {
    const { t } = useTranslation()
    // Facoltativi nel dialog di creazione, ma insieme: una risorsa senza ambiente (o il contrario) non collega niente
    const rules = required
        ? { required: t("validation.required") }
        : { validate: (_value: string, values: LinkFields) => Boolean(values.resourceId) === Boolean(values.environmentId) || t("database.provisioned.linkIncomplete") }

    return (
        <>
            <SelectField
                name="resourceId"
                label={t("database.provisioned.resource")}
                description={t("database.provisioned.resourceHint")}
                options={resources.filter(isLinkable).map(resource => ({ value: resource._id!, label: resource.name }))}
                noOptionsLabel={t("database.provisioned.noResources")}
                addClearButton={!required}
                clearLabel={t("database.provisioned.clearSelection")}
                onValueChange={onChange}
                rules={rules}
            />
            <SelectField
                name="environmentId"
                label={t("database.provisioned.environment")}
                options={environments.filter(environment => environment._id).map(environment => ({ value: environment._id!, label: environment.name }))}
                addClearButton={!required}
                clearLabel={t("database.provisioned.clearSelection")}
                onValueChange={onChange}
                rules={rules}
            />
        </>
    )
}

/** Crea un database e il suo utente sul server, e se scelti collega subito la risorsa nell'ambiente */
const CreateDatabaseDialog: React.FC<{ server: ConnectedDatabase; resources: Resource[]; environments: EnvironmentDTO[]; onClose: () => void }> = ({ server, resources, environments, onClose }) => {
    const { t } = useTranslation()
    const api = useDatabaseApi()
    const notifications = useToastNotificationStore()
    const refresh = useRefreshDatabases(server._id)
    const form = useForm<LinkFields & { databaseName: string }>({ defaultValues: { databaseName: "", resourceId: "", environmentId: "" } })

    // Il nome segue risorsa e ambiente finche' e' vuoto o e' ancora il suggerimento precedente: uno scritto a mano resta
    const [suggestion, setSuggestion] = useState("")
    const onLinkChange = () => {
        const { resourceId, environmentId, databaseName } = form.getValues()
        const next = suggestedName(
            resources.find(resource => resource._id === resourceId),
            environments.find(environment => environment._id === environmentId)
        )
        if (next && (!databaseName || databaseName === suggestion)) form.setValue("databaseName", next, { shouldValidate: true })
        setSuggestion(next)
        // Each select is checked against the other: once a submit showed the error, a change of either clears it
        if (form.formState.isSubmitted) form.trigger(["resourceId", "environmentId"])
    }

    const createMutation = useMutation({
        mutationFn: ({ databaseName, resourceId, environmentId }: LinkFields & { databaseName: string }) =>
            api.createProvisioned(server._id, { databaseName, ...(resourceId && environmentId && { link: { resourceId, environmentId } }) }),
        onSuccess: async created => {
            notifications.showSuccessNotification({ message: t("database.provisioned.created", { name: created.databaseName }) })
            await refresh()
            onClose()
        }
    })

    return (
        <Dialog open onOpenChange={open => !open && onClose()}>
            <DialogContent className="sm:max-w-[520px]">
                <FormProvider {...form}>
                    <form onSubmit={form.handleSubmit(values => createMutation.mutate(values))}>
                        <DialogHeader>
                            <DialogTitle>{t("database.provisioned.createTitle")}</DialogTitle>
                            <DialogDescription>{t("database.provisioned.createDescription", { server: server.name })}</DialogDescription>
                        </DialogHeader>
                        <div className="flex flex-col gap-4 py-4">
                            <LinkSelects resources={resources} environments={environments} required={false} onChange={onLinkChange} />
                            <TextField
                                name="databaseName"
                                dataTestId="provisioned-database-name"
                                label={t("database.provisioned.name")}
                                placeholder="report_steering_dev"
                                description={t("database.provisioned.nameHint")}
                                rules={{
                                    required: t("validation.required"),
                                    pattern: { value: PROVISIONED_DATABASE_NAME, message: t("database.provisioned.nameInvalid") },
                                    validate: value => !["admin", "local", "config"].includes(value) || t("database.provisioned.nameReserved")
                                }}
                            />
                        </div>
                        <DialogFooter>
                            <Button type="button" variant="secondary" onClick={onClose} disabled={createMutation.isPending}>
                                {t("common.cancel")}
                            </Button>
                            <Button type="submit" loading={createMutation.isPending} loadingLabel={t("common.loading")} dataTestId="provisioned-database-create-submit">
                                {t("common.create")}
                            </Button>
                        </DialogFooter>
                    </form>
                </FormProvider>
            </DialogContent>
        </Dialog>
    )
}

/** Collega un database a una risorsa in un ambiente: i campi della risorsa in quell'ambiente vengono sovrascritti */
const LinkDatabaseDialog: React.FC<{ database: ProvisionedDatabase; resources: Resource[]; environments: EnvironmentDTO[]; onClose: () => void }> = ({
    database,
    resources,
    environments,
    onClose
}) => {
    const { t } = useTranslation()
    const api = useDatabaseApi()
    const notifications = useToastNotificationStore()
    const refresh = useRefreshDatabases(database.databaseId)
    const form = useForm<LinkFields>({ defaultValues: { resourceId: "", environmentId: "" } })

    const linkMutation = useMutation({
        mutationFn: (link: LinkFields) => api.linkProvisioned(database._id, link),
        onSuccess: async () => {
            notifications.showSuccessNotification({ message: t("database.provisioned.linked", { name: database.databaseName }) })
            await refresh()
            onClose()
        }
    })

    return (
        <Dialog open onOpenChange={open => !open && onClose()}>
            <DialogContent className="sm:max-w-[520px]">
                <FormProvider {...form}>
                    <form onSubmit={form.handleSubmit(values => linkMutation.mutate(values))}>
                        <DialogHeader>
                            <DialogTitle>{t("database.provisioned.linkTitle", { name: database.databaseName })}</DialogTitle>
                            <DialogDescription>{t("database.provisioned.linkDescription")}</DialogDescription>
                        </DialogHeader>
                        <div className="flex flex-col gap-4 py-4">
                            <LinkSelects resources={resources} environments={environments} required />
                        </div>
                        <DialogFooter>
                            <Button type="button" variant="secondary" onClick={onClose} disabled={linkMutation.isPending}>
                                {t("common.cancel")}
                            </Button>
                            <Button type="submit" loading={linkMutation.isPending} loadingLabel={t("common.loading")} dataTestId="provisioned-database-link-submit">
                                {t("database.provisioned.link")}
                            </Button>
                        </DialogFooter>
                    </form>
                </FormProvider>
            </DialogContent>
        </Dialog>
    )
}

const DELETE_MODES: ProvisionedDatabaseDeleteMode[] = ["record", "user", "drop"]

/** Cosa togliere con il database: solo il record, anche l'utente, o anche i dati (con il nome riscritto) */
const DeleteDatabaseDialog: React.FC<{ database: ProvisionedDatabase; onClose: () => void }> = ({ database, onClose }) => {
    const { t } = useTranslation()
    const api = useDatabaseApi()
    const notifications = useToastNotificationStore()
    const refresh = useRefreshDatabases(database.databaseId)
    const idPrefix = useId()
    const [mode, setMode] = useState<ProvisionedDatabaseDeleteMode>("record")
    const [confirmName, setConfirmName] = useState("")
    const confirmed = mode !== "drop" || confirmName === database.databaseName

    const deleteMutation = useMutation({
        mutationFn: () => api.deleteProvisioned(database._id, mode, mode === "drop" ? confirmName : undefined),
        onSuccess: async () => {
            notifications.showSuccessNotification({ message: t("database.provisioned.deleted", { name: database.databaseName }) })
            await refresh()
            onClose()
        }
    })

    return (
        <Dialog open onOpenChange={open => !open && onClose()}>
            <DialogContent className="sm:max-w-[520px]">
                <form
                    onSubmit={event => {
                        event.preventDefault()
                        if (confirmed) deleteMutation.mutate()
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>{t("database.provisioned.deleteTitle", { name: database.databaseName })}</DialogTitle>
                        <DialogDescription>{t("database.provisioned.deleteDescription")}</DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-4 py-4">
                        {database.status === "cleanupRequired" && (
                            <Alert variant="warning">
                                <TriangleAlert className="size-4" aria-hidden="true" />
                                <AlertDescription>{t("database.provisioned.cleanupRequiredDelete", { username: database.username })}</AlertDescription>
                            </Alert>
                        )}
                        <RadioGroup
                            value={mode}
                            onValueChange={value => setMode(value as ProvisionedDatabaseDeleteMode)}
                            aria-label={t("database.provisioned.deleteModeLabel")}
                            dataTestId="provisioned-database-delete-mode"
                        >
                            {/* Il database di un utente rimasto sul server puo' essere di qualcun altro: niente drop, solo l'utente o il record */}
                            {DELETE_MODES.filter(candidate => database.status !== "cleanupRequired" || candidate !== "drop").map(candidate => (
                                <div key={candidate} className="flex items-start gap-2">
                                    <RadioGroupItem id={`${idPrefix}-${candidate}`} value={candidate} className="mt-0.5" />
                                    <Label htmlFor={`${idPrefix}-${candidate}`} className="flex cursor-pointer flex-col gap-0.5">
                                        <span>{t(`database.provisioned.deleteModes.${candidate}`)}</span>
                                        <span className="text-xs font-normal text-foreground-secondary">{t(`database.provisioned.deleteModes.${candidate}Hint`)}</span>
                                    </Label>
                                </div>
                            ))}
                        </RadioGroup>
                        {mode === "drop" && (
                            <>
                                <Alert variant="destructive">
                                    <TriangleAlert className="size-4" aria-hidden="true" />
                                    <AlertDescription>{t("database.provisioned.dropWarning", { name: database.databaseName })}</AlertDescription>
                                </Alert>
                                <div className="flex flex-col gap-1.5">
                                    <Label htmlFor={`${idPrefix}-confirm`}>{t("database.provisioned.dropConfirmation", { name: database.databaseName })}</Label>
                                    <Input
                                        id={`${idPrefix}-confirm`}
                                        value={confirmName}
                                        onChange={event => setConfirmName(event.target.value)}
                                        placeholder={database.databaseName}
                                        autoComplete="off"
                                        dataTestId="provisioned-database-drop-confirm"
                                    />
                                </div>
                            </>
                        )}
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="secondary" onClick={onClose} disabled={deleteMutation.isPending}>
                            {t("common.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            variant="destructive"
                            disabled={!confirmed}
                            loading={deleteMutation.isPending}
                            loadingLabel={t("common.deleting")}
                            dataTestId="provisioned-database-delete-submit"
                        >
                            {t("common.delete")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    )
}

/** I database creati su un server: chi li usa, e le azioni per crearli, collegarli, scollegarli e rimuoverli */
export const ProvisionedDatabasesSection: React.FC<{ server: ConnectedDatabase }> = ({ server }) => {
    const { t } = useTranslation()
    const api = useDatabaseApi()
    const isViewer = useIsProjectViewer()
    const notifications = useToastNotificationStore()
    const refresh = useRefreshDatabases(server._id)
    const [creating, setCreating] = useState(false)
    const [linking, setLinking] = useState<ProvisionedDatabase>()
    const [deleting, setDeleting] = useState<ProvisionedDatabase>()

    const databasesQuery = useQuery({ queryKey: ["database-provisioned", server._id], queryFn: () => api.getProvisioned(server._id) })
    const resources = useResourcesQuery().data ?? []
    const environments = useProjectEnvironmentsQuery().data ?? []

    const unlinkMutation = useMutation({
        mutationFn: (database: ProvisionedDatabase) => api.unlinkProvisioned(database._id),
        onSuccess: async database => {
            notifications.showSuccessNotification({ message: t("database.provisioned.unlinked", { name: database.databaseName }) })
            await refresh()
        }
    })

    const linkLabel = (database: ProvisionedDatabase) => {
        if (!database.link) return undefined
        const resource = resources.find(candidate => candidate._id === database.link?.resourceId)?.name ?? database.link.resourceId
        const environment = environments.find(candidate => candidate._id === database.link?.environmentId)?.name ?? database.link.environmentId
        return `${resource} / ${environment}`
    }

    const databases = databasesQuery.data ?? []
    // The users a failed create left on the server: said at the top, never forgotten
    const leftOnServer = databases.filter(database => database.status === "cleanupRequired")

    return (
        <Card>
            <CardHeader>
                <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                        <Database className="h-5 w-5 text-muted-foreground" />
                        <CardTitle>{t("database.provisioned.title")}</CardTitle>
                    </div>
                    {!isViewer && (
                        <Button type="button" onClick={() => setCreating(true)} dataTestId="provisioned-database-new">
                            <PlusCircle />
                            {t("database.provisioned.create")}
                        </Button>
                    )}
                </div>
                <CardDescription>{t("database.provisioned.description")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                {leftOnServer.length > 0 && (
                    <Alert variant="warning" dataTestId="provisioned-databases-cleanup-required">
                        <TriangleAlert className="size-4" aria-hidden="true" />
                        <AlertDescription>{t("database.provisioned.cleanupRequiredNotice", { users: leftOnServer.map(database => database.username).join(", ") })}</AlertDescription>
                    </Alert>
                )}
                {databases.length > 0 ? (
                    <Table framed>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t("database.provisioned.name")}</TableHead>
                                <TableHead>{t("database.provisioned.username")}</TableHead>
                                <TableHead>{t("database.provisioned.linkedTo")}</TableHead>
                                <TableHead />
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {databases.map(database => (
                                <TableRow key={database._id} data-testid={`provisioned-database-row-${database.databaseName}`}>
                                    <TableCell className="font-mono text-sm">{database.databaseName}</TableCell>
                                    <TableCell className="font-mono text-sm">{database.username}</TableCell>
                                    <TableCell>
                                        {database.status === "cleanupRequired" ? (
                                            // Un utente creato da Flightroom e rimasto sul server: si dice, non si dimentica
                                            <span title={database.cleanupReason} className="inline-flex">
                                                <Badge variant="destructive" dataTestId={`provisioned-database-cleanup-${database.databaseName}`}>
                                                    <TriangleAlert className="size-3" aria-hidden="true" />
                                                    {t("database.provisioned.cleanupRequired")}
                                                </Badge>
                                            </span>
                                        ) : database.removedFromServer ? (
                                            // Una rimozione fermata a meta': si finisce di rimuovere, non si collega
                                            <Badge variant="warning" dataTestId={`provisioned-database-partly-removed-${database.databaseName}`}>
                                                <TriangleAlert className="size-3" aria-hidden="true" />
                                                {t(`database.provisioned.partlyRemoved.${database.removedFromServer}`)}
                                            </Badge>
                                        ) : database.link ? (
                                            <Badge variant="outline">{linkLabel(database)}</Badge>
                                        ) : (
                                            <span className="text-sm text-foreground-secondary">{t("database.provisioned.notLinked")}</span>
                                        )}
                                    </TableCell>
                                    <TableCell>
                                        {!isViewer && (
                                            <div className="flex justify-end gap-2">
                                                {database.link ? (
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="icon"
                                                        disabled={unlinkMutation.isPending}
                                                        aria-label={t("database.provisioned.unlink", { name: database.databaseName })}
                                                        title={t("database.provisioned.unlink", { name: database.databaseName })}
                                                        onClick={() => unlinkMutation.mutate(database)}
                                                        dataTestId={`provisioned-database-unlink-${database.databaseName}`}
                                                    >
                                                        <Link2Off />
                                                    </Button>
                                                ) : (
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="icon"
                                                        disabled={database.status === "cleanupRequired" || Boolean(database.removedFromServer)}
                                                        aria-label={t("database.provisioned.linkTitle", { name: database.databaseName })}
                                                        title={t("database.provisioned.linkTitle", { name: database.databaseName })}
                                                        onClick={() => setLinking(database)}
                                                        dataTestId={`provisioned-database-link-${database.databaseName}`}
                                                    >
                                                        <Link2 />
                                                    </Button>
                                                )}
                                                {/* Il backend la rifiuta finche' il database alimenta una risorsa: il pulsante lo dice prima */}
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="icon"
                                                    disabled={Boolean(database.link)}
                                                    aria-label={database.link ? t("database.provisioned.unlinkFirst") : t("database.provisioned.deleteTitle", { name: database.databaseName })}
                                                    title={database.link ? t("database.provisioned.unlinkFirst") : t("database.provisioned.deleteTitle", { name: database.databaseName })}
                                                    className="text-destructive hover:bg-destructive/15 hover:text-destructive-active"
                                                    onClick={() => setDeleting(database)}
                                                    dataTestId={`provisioned-database-delete-${database.databaseName}`}
                                                >
                                                    <Trash2 />
                                                </Button>
                                            </div>
                                        )}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                ) : (
                    <EmptyState size="sm" description={t("database.provisioned.none")} />
                )}
            </CardContent>

            {creating && <CreateDatabaseDialog server={server} resources={resources} environments={environments} onClose={() => setCreating(false)} />}
            {linking && <LinkDatabaseDialog database={linking} resources={resources} environments={environments} onClose={() => setLinking(undefined)} />}
            {deleting && <DeleteDatabaseDialog database={deleting} onClose={() => setDeleting(undefined)} />}
        </Card>
    )
}

export default ProvisionedDatabasesSection
