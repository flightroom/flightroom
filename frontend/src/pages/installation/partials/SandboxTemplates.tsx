import {
    Alert,
    AlertDescription,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Checkbox,
    DeleteConfirmationDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Form,
    Label,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow
} from "@flightroom/design-system"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { AxiosError } from "axios"
import { Pencil, Plus, Trash2 } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Badge, Button } from "@/components/atoms"
import TextareaField from "@/components/input/TextareaField.rhf"
import TextField from "@/components/input/TextField.rhf"
import { ApiStatusHandler } from "@/components/organisms"
import LanguageLogo from "@/components/technology/LanguageLogo"
import useInstallationApi, {
    INSTALLATION_SANDBOXES_QUERY_KEY,
    SANDBOX_LANGUAGES,
    SANDBOX_SETTINGS_QUERY_KEY,
    SANDBOX_TEMPLATES_QUERY_KEY,
    type SandboxLanguage,
    type SandboxTemplate,
    type SandboxTemplateInput
} from "@/hooks/apiClients/useInstallationApi"
import { errorCodeOf } from "@/hooks/useApiClient"
import useToastNotificationStore from "@/store/useToastNotificationStore"

/** The same checks as the backend's: a DNS label of at most 19 characters, as the gateway caps template names. */
const NAME = /^[a-z0-9]([a-z0-9-]{0,17}[a-z0-9])?$/
const CPU = /^[0-9]+(\.[0-9]+)?m?$/
const MEMORY = /^[0-9]+(\.[0-9]+)?(Ki|Mi|Gi|Ti|k|M|G|T)?$/
const LABEL_KEY = /^([a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/
const LABEL_VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)?$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
/** The backend's limits: beyond them a template is refused without saying which field. */
const MAX_IMAGE = 500
const MAX_LABELS = 20
const MAX_VARIABLES = 50
const MAX_VALUE = 4000

interface TemplateFormValues {
    name: string
    image: string
    cpu: string
    memory: string
    /** KEY=value, one per line. */
    labels: string
    environment: string
    languages: SandboxLanguage[]
}

/** The KEY=value lines, blank ones skipped: the key trimmed, the value as typed, spaces included. */
const pairsOf = (text: string): [string, string][] =>
    text
        .split("\n")
        .filter(line => line.trim())
        .map(line => {
            const at = line.indexOf("=")
            return at < 0 ? [line.trim(), ""] : [line.slice(0, at).trim(), line.slice(at + 1)]
        })

const toPairs = (text: string): Record<string, string> => Object.fromEntries(pairsOf(text))

const toText = (pairs: Record<string, string>) =>
    Object.entries(pairs)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")

const toFormValues = (template?: SandboxTemplate): TemplateFormValues => ({
    name: template?.name ?? "",
    image: template?.image ?? "",
    cpu: template?.cpu ?? "",
    memory: template?.memory ?? "",
    // A new template is labelled as the ones of this console on the gateway are.
    labels: template ? toText(template.labels) : "app=flightroom",
    environment: template ? toText(template.environment) : "",
    languages: template?.languages ?? []
})

const toInput = (values: TemplateFormValues): SandboxTemplateInput => ({
    image: values.image.trim(),
    cpu: values.cpu.trim() || null,
    memory: values.memory.trim() || null,
    labels: toPairs(values.labels),
    environment: toPairs(values.environment),
    // In the order of the list, as the backend gives them back.
    languages: SANDBOX_LANGUAGES.filter(language => values.languages.includes(language))
})

/** What the gateway said of a template it refused: written for the log, in English, but it says what to fix. */
const refusalOf = (error: Error) => (error as AxiosError<{ error?: { message?: string } }>)?.response?.data?.error?.message

interface TemplateFormDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    /** The template to change; a new one when missing. */
    template?: SandboxTemplate
}

/** Creates a workload template on the gateway, or changes one: its name stays, the gateway knows it by it. */
const TemplateFormDialog: React.FC<TemplateFormDialogProps> = ({ open, onOpenChange, template }) => {
    const { t } = useTranslation()
    const installationApi = useInstallationApi()
    const notifications = useToastNotificationStore()
    const queryClient = useQueryClient()
    const form = useForm<TemplateFormValues>({ defaultValues: toFormValues(template) })
    const languagesId = useId()
    const languages = form.watch("languages")
    const toggleLanguage = (language: SandboxLanguage, checked: boolean) =>
        form.setValue("languages", checked ? [...languages, language] : languages.filter(held => held !== language), { shouldDirty: true })

    // Every opening starts from the template it is opened on, or from a blank form.
    useEffect(() => {
        if (open) form.reset(toFormValues(template))
    }, [open, template, form])

    const saveMutation = useMutation({
        mutationFn: (values: TemplateFormValues) =>
            template ? installationApi.updateSandboxTemplate(template.name, toInput(values)) : installationApi.createSandboxTemplate(values.name.trim(), toInput(values)),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: [SANDBOX_TEMPLATES_QUERY_KEY] })
            // Changing the template in use lets the warm sandboxes go: the pool and the list move.
            queryClient.invalidateQueries({ queryKey: [SANDBOX_SETTINGS_QUERY_KEY] })
            queryClient.invalidateQueries({ queryKey: [INSTALLATION_SANDBOXES_QUERY_KEY] })
            notifications.showSuccessNotification({ message: t(template ? "installation.templates.updated" : "installation.templates.created") })
            onOpenChange(false)
        },
        onError: (error: Error) => {
            const code = errorCodeOf(error)
            if (code === "SANDBOX_TEMPLATE_LOST") {
                // The template is no longer on the gateway: the list shows it, the dialog has nothing left to edit.
                queryClient.invalidateQueries({ queryKey: [SANDBOX_TEMPLATES_QUERY_KEY] })
                notifications.showErrorNotification({ message: t("installation.templates.errors.lost", { name: template?.name ?? "" }) })
                onOpenChange(false)
                return
            }
            if (code === "SANDBOX_TEMPLATE_EXISTS") {
                form.setError("name", { message: t("installation.templates.errors.exists") })
                return
            }
            if (code === "SANDBOX_TEMPLATE_INVALID") {
                notifications.showErrorNotification({ message: t("installation.templates.errors.refused", { reason: refusalOf(error) ?? "" }) })
                return
            }
            if (code === "SANDBOX_GATEWAY_FORBIDDEN") {
                notifications.showErrorNotification({ message: t("installation.templates.errors.forbidden", { reason: refusalOf(error) ?? "" }) })
                return
            }
            notifications.showErrorNotification({ message: t(code === "SANDBOX_GATEWAY_NOT_CONFIGURED" ? "installation.templates.errors.no_gateway" : "installation.templates.errors.save_failed") })
        }
    })

    const required = { required: t("validation.required") }
    const pattern = (regex: RegExp, message: string) => ({ validate: (value: string) => !value.trim() || regex.test(value.trim()) || message })
    const pairsRules = (key: RegExp, value: RegExp | undefined, message: string, max: number) => ({
        validate: (text: string) => {
            const pairs = pairsOf(text)
            if (pairs.length > max) return t("installation.templates.validation.too_many", { max })
            if (new Set(pairs.map(([name]) => name)).size < pairs.length) return t("installation.templates.validation.duplicate")
            if (pairs.some(([, content]) => content.length > MAX_VALUE)) return t("validation.max_length", { count: MAX_VALUE })
            const lines = text.split("\n").filter(line => line.trim())
            return lines.every((line, index) => line.indexOf("=") > 0 && key.test(pairs[index][0]) && (!value || value.test(pairs[index][1]))) || message
        }
    })

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[560px]">
                <Form {...form}>
                    <form onSubmit={form.handleSubmit(values => saveMutation.mutate(values))}>
                        <DialogHeader>
                            <DialogTitle>{template ? t("installation.templates.form.edit_title", { name: template.name }) : t("installation.templates.form.add_title")}</DialogTitle>
                            <DialogDescription>{t(template ? "installation.templates.form.edit_description" : "installation.templates.form.add_description")}</DialogDescription>
                        </DialogHeader>
                        <div className="grid gap-4 py-4">
                            {template?.inUse && (
                                <Alert variant="warning" data-testid="installation-template-in-use-warning">
                                    <AlertDescription>{t("installation.templates.form.in_use_warning")}</AlertDescription>
                                </Alert>
                            )}
                            {template?.advanced && (
                                <Alert variant="info">
                                    <AlertDescription>{t("installation.templates.form.advanced_kept")}</AlertDescription>
                                </Alert>
                            )}
                            <TextField<TemplateFormValues>
                                name="name"
                                label={t("installation.templates.form.name")}
                                placeholder={t("installation.templates.form.name_placeholder")}
                                description={t("installation.templates.form.name_help")}
                                disabled={!!template}
                                autoComplete="off"
                                required
                                rules={{ ...required, ...pattern(NAME, t("installation.templates.validation.name")) }}
                                dataTestId="installation-template-name"
                            />
                            <TextField<TemplateFormValues>
                                name="image"
                                label={t("installation.templates.form.image")}
                                placeholder={t("installation.templates.form.image_placeholder")}
                                description={t("installation.templates.form.image_help")}
                                autoComplete="off"
                                required
                                rules={{
                                    ...required,
                                    maxLength: { value: MAX_IMAGE, message: t("validation.max_length", { count: MAX_IMAGE }) },
                                    validate: (value: string) => !/\s/.test(value.trim()) || t("installation.settings.validation.no_spaces")
                                }}
                                dataTestId="installation-template-image"
                            />
                            <div className="grid gap-4 md:grid-cols-2">
                                <TextField<TemplateFormValues>
                                    name="cpu"
                                    label={t("installation.templates.form.cpu")}
                                    placeholder={t("installation.templates.form.cpu_placeholder")}
                                    description={t("installation.templates.form.cpu_help")}
                                    autoComplete="off"
                                    rules={pattern(CPU, t("installation.templates.validation.cpu"))}
                                    dataTestId="installation-template-cpu"
                                />
                                <TextField<TemplateFormValues>
                                    name="memory"
                                    label={t("installation.templates.form.memory")}
                                    placeholder={t("installation.templates.form.memory_placeholder")}
                                    description={t("installation.templates.form.memory_help")}
                                    autoComplete="off"
                                    rules={pattern(MEMORY, t("installation.templates.validation.memory"))}
                                    dataTestId="installation-template-memory"
                                />
                            </div>
                            <fieldset className="flex flex-col gap-2" aria-describedby={`${languagesId}-help`} data-testid="installation-template-languages">
                                <legend className="mb-1 text-sm font-medium">{t("installation.templates.form.languages")}</legend>
                                <div className="flex flex-wrap gap-x-5 gap-y-2">
                                    {SANDBOX_LANGUAGES.map(language => (
                                        <div key={language} className="flex items-center gap-2">
                                            <Checkbox
                                                id={`${languagesId}-${language}`}
                                                checked={languages.includes(language)}
                                                disabled={saveMutation.isPending}
                                                onCheckedChange={checked => toggleLanguage(language, checked === true)}
                                                dataTestId={`installation-template-language-${language}`}
                                            />
                                            <Label htmlFor={`${languagesId}-${language}`} className="flex cursor-pointer items-center gap-1.5">
                                                <LanguageLogo language={language} />
                                                {t(`installation.templates.language_names.${language}`)}
                                            </Label>
                                        </div>
                                    ))}
                                </div>
                                <p id={`${languagesId}-help`} className="text-sm text-foreground-secondary">
                                    {t("installation.templates.form.languages_help")}
                                </p>
                            </fieldset>
                            <TextareaField<TemplateFormValues>
                                name="labels"
                                label={t("installation.templates.form.labels")}
                                description={t("installation.templates.form.labels_help")}
                                rows={3}
                                rules={pairsRules(LABEL_KEY, LABEL_VALUE, t("installation.templates.validation.labels"), MAX_LABELS)}
                                dataTestId="installation-template-labels"
                            />
                            <TextareaField<TemplateFormValues>
                                name="environment"
                                label={t("installation.templates.form.environment")}
                                description={t("installation.templates.form.environment_help")}
                                rows={3}
                                rules={pairsRules(ENV_NAME, undefined, t("installation.templates.validation.environment"), MAX_VARIABLES)}
                                dataTestId="installation-template-environment"
                            />
                        </div>
                        <DialogFooter>
                            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={saveMutation.isPending}>
                                {t("common.cancel")}
                            </Button>
                            <Button type="submit" loading={saveMutation.isPending} loadingLabel={t("common.loading")} dataTestId="installation-template-save">
                                {t("common.save")}
                            </Button>
                        </DialogFooter>
                    </form>
                </Form>
            </DialogContent>
        </Dialog>
    )
}

interface SandboxTemplatesProps {
    /** Without a gateway there is no template to list nor to create. */
    gatewayConfigured: boolean
}

/**
 * The workload templates of the OpenShell gateway: the image, resources, labels and environment each sandbox is
 * created with. They live on the gateway, shared by the installations on its workspace, instead of in this database.
 */
export const SandboxTemplates: React.FC<SandboxTemplatesProps> = ({ gatewayConfigured }) => {
    const { t } = useTranslation()
    const installationApi = useInstallationApi()
    const notifications = useToastNotificationStore()
    const queryClient = useQueryClient()
    // The template stays while the dialog closes, so its title does not turn into the new template's on the way out.
    const [editing, setEditing] = useState<{ open: boolean; template?: SandboxTemplate }>({ open: false })
    const [toDelete, setToDelete] = useState<SandboxTemplate>()

    const templatesQuery = useQuery({ queryKey: [SANDBOX_TEMPLATES_QUERY_KEY], queryFn: installationApi.getSandboxTemplates, enabled: gatewayConfigured })

    const deleteMutation = useMutation({
        mutationFn: (name: string) => installationApi.deleteSandboxTemplate(name),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: [SANDBOX_TEMPLATES_QUERY_KEY] })
            notifications.showSuccessNotification({ message: t("installation.templates.delete.deleted") })
        },
        onError: (error: Error) => {
            const code = errorCodeOf(error)
            if (code === "SANDBOX_GATEWAY_FORBIDDEN") {
                notifications.showErrorNotification({ message: t("installation.templates.errors.forbidden", { reason: refusalOf(error) ?? "" }) })
                return
            }
            notifications.showErrorNotification({ message: t(code === "SANDBOX_TEMPLATE_IN_USE" ? "installation.templates.delete.in_use" : "installation.templates.delete.failed") })
        }
    })

    return (
        <Card className="pt-4" data-testid="installation-sandbox-templates">
            <CardHeader className="flex flex-row items-start justify-between gap-4">
                <div className="flex flex-col gap-1.5">
                    <CardTitle as="h2">{t("installation.templates.title")}</CardTitle>
                    <CardDescription>{t("installation.templates.description")}</CardDescription>
                </div>
                {gatewayConfigured && (
                    <Button size="sm" className="shrink-0" onClick={() => setEditing({ open: true })} dataTestId="installation-template-add">
                        <Plus className="size-4" aria-hidden="true" />
                        {t("installation.templates.add")}
                    </Button>
                )}
            </CardHeader>
            <CardContent className="pt-4">
                {!gatewayConfigured ? (
                    <p className="text-sm text-foreground-secondary">{t("installation.templates.no_gateway")}</p>
                ) : templatesQuery.error && errorCodeOf(templatesQuery.error) === "SANDBOX_GATEWAY_FORBIDDEN" ? (
                    // The gateway says which role this installation lacks and the command that grants it
                    <Alert variant="warning" data-testid="installation-templates-forbidden">
                        <AlertDescription className="break-words">{t("installation.templates.errors.forbidden", { reason: refusalOf(templatesQuery.error) ?? "" })}</AlertDescription>
                    </Alert>
                ) : templatesQuery.data === undefined ? (
                    <ApiStatusHandler queries={[templatesQuery]}>{null}</ApiStatusHandler>
                ) : templatesQuery.data.length === 0 ? (
                    <p className="text-sm text-foreground-secondary">{t("installation.templates.empty")}</p>
                ) : (
                    <div className="overflow-x-auto">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("installation.templates.columns.name")}</TableHead>
                                    <TableHead>{t("installation.templates.columns.image")}</TableHead>
                                    <TableHead>{t("installation.templates.columns.resources")}</TableHead>
                                    <TableHead>{t("installation.templates.columns.languages")}</TableHead>
                                    <TableHead>{t("installation.templates.columns.labels")}</TableHead>
                                    <TableHead>
                                        <span className="sr-only">{t("installation.templates.columns.actions")}</span>
                                    </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {templatesQuery.data.map(template => (
                                    <TableRow key={template.name} data-testid={`installation-template-${template.name}`}>
                                        <TableCell>
                                            <div className="flex items-center gap-2">
                                                <span className="font-mono text-xs">{template.name}</span>
                                                {template.inUse && <Badge variant="success">{t("installation.templates.in_use")}</Badge>}
                                            </div>
                                        </TableCell>
                                        <TableCell className="max-w-[320px]">
                                            <span className="block truncate font-mono text-xs" title={template.image}>
                                                {template.image}
                                            </span>
                                        </TableCell>
                                        <TableCell className="whitespace-nowrap text-sm">
                                            {template.cpu || template.memory
                                                ? t("installation.templates.resources", { cpu: template.cpu ?? "-", memory: template.memory ?? "-" })
                                                : t("installation.templates.no_limits")}
                                        </TableCell>
                                        <TableCell>
                                            {template.languages.length ? (
                                                <div className="flex flex-wrap gap-1">
                                                    {template.languages.map(language => (
                                                        <Badge key={language} variant="outline" className="gap-1">
                                                            <LanguageLogo language={language} size={12} />
                                                            {t(`installation.templates.language_names.${language}`)}
                                                        </Badge>
                                                    ))}
                                                </div>
                                            ) : (
                                                <span className="text-sm text-foreground-secondary">{t("installation.templates.no_languages")}</span>
                                            )}
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex flex-wrap gap-1">
                                                {Object.entries(template.labels).map(([key, value]) => (
                                                    <Badge key={key} variant="outline">
                                                        {key}={value}
                                                    </Badge>
                                                ))}
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex justify-end gap-1">
                                                <Button
                                                    variant="ghost"
                                                    size="icon-sm"
                                                    aria-label={t("installation.templates.edit", { name: template.name })}
                                                    title={t("installation.templates.edit", { name: template.name })}
                                                    onClick={() => setEditing({ open: true, template })}
                                                    dataTestId={`installation-template-edit-${template.name}`}
                                                >
                                                    <Pencil className="size-4" aria-hidden="true" />
                                                </Button>
                                                <Button
                                                    variant="ghost-destructive"
                                                    size="icon-sm"
                                                    aria-label={t("installation.templates.delete.open", { name: template.name })}
                                                    title={template.inUse ? t("installation.templates.delete.in_use") : t("installation.templates.delete.open", { name: template.name })}
                                                    disabled={template.inUse}
                                                    onClick={() => setToDelete(template)}
                                                    dataTestId={`installation-template-delete-${template.name}`}
                                                >
                                                    <Trash2 className="size-4" aria-hidden="true" />
                                                </Button>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                )}
            </CardContent>

            <TemplateFormDialog open={editing.open} onOpenChange={open => !open && setEditing(current => ({ ...current, open: false }))} template={editing.template} />
            <DeleteConfirmationDialog
                isOpen={!!toDelete}
                onOpenChange={open => !open && setToDelete(undefined)}
                onDelete={async () => {
                    if (toDelete) await deleteMutation.mutateAsync(toDelete.name)
                }}
                onDeleteSuccess={() => setToDelete(undefined)}
                title={t("installation.templates.delete.title", { name: toDelete?.name ?? "" })}
                description={t("installation.templates.delete.description")}
                cancelLabel={t("common.cancel")}
                deleteLabel={t("common.delete")}
                deletingLabel={t("installation.templates.delete.deleting")}
                dataTestId="installation-template-delete-dialog"
            />
        </Card>
    )
}

export default SandboxTemplates
