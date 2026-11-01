import { Alert, AlertDescription, AlertTitle, Card, CardContent, CardDescription, CardHeader, CardTitle, Form, SelectField } from "@flightroom/design-system"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { format } from "date-fns"
import { ShieldAlert } from "lucide-react"
import { useEffect } from "react"
import { useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import TextField from "@/components/input/TextField.rhf"
import useInstallationApi, {
    SANDBOX_SETTINGS_QUERY_KEY,
    SANDBOX_TEMPLATES_QUERY_KEY,
    type SandboxSettingsSummary,
    type SandboxSettingsUpdate,
    type SandboxSettingsValues
} from "@/hooks/apiClients/useInstallationApi"
import useThemeStore from "@/store/useThemeStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"

/** A select item cannot carry an empty value: this one stands for "the environment's value". */
const DEFAULT = "default"

const NUMBER_FIELDS = { idleMinutes: [1, 1440], maxHours: [1, 720], warmSandboxes: [0, 50] } as const
const TEXT_FIELDS = ["image"] as const
const LIST_FIELDS = ["registryHosts", "networkBinary"] as const

/** The same checks as the backend's: a host name, `*.` allowed in front; an absolute path without spaces nor commas. */
const HOST = /^(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
const PATH = /^\/[^\s,]*$/
/** Where the browser reaches the previews, `*` standing for each one: https://*.sandbox.example.com. */
const PREVIEW_URL = /^https?:\/\/\*\.[A-Za-z0-9.-]+(:[0-9]{1,5})?\/?$/

type NumberField = keyof typeof NUMBER_FIELDS

type FormValues = Record<NumberField | (typeof TEXT_FIELDS)[number] | (typeof LIST_FIELDS)[number], string> & {
    /** A template of the gateway, by name, or DEFAULT for the environment's. */
    template: string
    sharing: typeof DEFAULT | "domain" | "conversation"
    previewsEnabled: typeof DEFAULT | "on" | "off"
    previewUrl: string
}

const toFormValues = (values: SandboxSettingsValues): FormValues => ({
    idleMinutes: values.idleMinutes === undefined ? "" : String(values.idleMinutes),
    maxHours: values.maxHours === undefined ? "" : String(values.maxHours),
    warmSandboxes: values.warmSandboxes === undefined ? "" : String(values.warmSandboxes),
    sharing: values.sharing ?? DEFAULT,
    previewsEnabled: values.previewsEnabled === undefined ? DEFAULT : values.previewsEnabled ? "on" : "off",
    previewUrl: values.previewUrl ?? "",
    image: values.image ?? "",
    template: values.template ?? DEFAULT,
    registryHosts: values.registryHosts ?? "",
    networkBinary: values.networkBinary ?? ""
})

/** Every setting is sent: an empty one is null, which puts the environment's value back. */
const toUpdate = (values: FormValues): SandboxSettingsUpdate => ({
    idleMinutes: values.idleMinutes.trim() ? Number(values.idleMinutes) : null,
    maxHours: values.maxHours.trim() ? Number(values.maxHours) : null,
    warmSandboxes: values.warmSandboxes.trim() ? Number(values.warmSandboxes) : null,
    sharing: values.sharing === DEFAULT ? null : values.sharing,
    previewsEnabled: values.previewsEnabled === DEFAULT ? null : values.previewsEnabled === "on",
    previewUrl: values.previewUrl.trim() || null,
    image: values.image.trim() || null,
    template: values.template === DEFAULT ? null : values.template,
    registryHosts: values.registryHosts.trim() || null,
    networkBinary: values.networkBinary.trim() || null
})

interface SandboxSettingsFormProps {
    summary: SandboxSettingsSummary
}

/**
 * The settings of the coding agent's sandboxes for the whole installation. Each field left empty is the environment
 * variable's value, shown as its placeholder; what the sandbox runs and may reach applies to new sandboxes only.
 */
export const SandboxSettingsForm: React.FC<SandboxSettingsFormProps> = ({ summary }) => {
    const { t } = useTranslation()
    const themeStore = useThemeStore()
    const installationApi = useInstallationApi()
    const notifications = useToastNotificationStore()
    const queryClient = useQueryClient()
    const form = useForm<FormValues>({ defaultValues: toFormValues(summary.values) })
    const { defaults } = summary
    // The templates the gateway has: the one saved stays among the choices even when the gateway does not list it (any longer).
    const templatesQuery = useQuery({
        queryKey: [SANDBOX_TEMPLATES_QUERY_KEY],
        queryFn: installationApi.getSandboxTemplates,
        enabled: summary.gateway.status !== "notConfigured"
    })

    // The page reads the settings again every 30 seconds, gateway and pool included: only a change of what is stored,
    // saved on another tab or by another administrator, resets the form, and never over edits not saved yet.
    const stored = JSON.stringify(summary.values)
    useEffect(() => {
        if (!form.formState.isDirty) form.reset(toFormValues(JSON.parse(stored) as SandboxSettingsValues))
    }, [stored, form])

    const saveMutation = useMutation({
        mutationFn: (values: FormValues) => installationApi.updateSandboxSettings(toUpdate(values)),
        onSuccess: saved => {
            // What the server stored, tidied: the form starts again from it, no longer dirty.
            form.reset(toFormValues(saved.values))
            queryClient.setQueryData([SANDBOX_SETTINGS_QUERY_KEY], saved)
            notifications.showSuccessNotification({ message: t("installation.settings.saved") })
        },
        onError: () => notifications.showErrorNotification({ message: t("installation.settings.save_failed") })
    })

    const numberRules = (field: NumberField) => {
        const [min, max] = NUMBER_FIELDS[field]
        return {
            validate: (value: string) => !value.trim() || (Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max) || t("installation.settings.validation.range", { min, max })
        }
    }
    const textRules = { validate: (value: string) => !/\s/.test(value.trim()) || t("installation.settings.validation.no_spaces") }
    const previewUrlRules = { validate: (value: string) => !value.trim() || PREVIEW_URL.test(value.trim()) || t("installation.settings.validation.preview_url") }
    const listRules = (pattern: RegExp, message: string) => ({
        validate: (value: string) =>
            !value.trim() ||
            value
                .split(",")
                .map(item => item.trim())
                .every(item => pattern.test(item)) ||
            message
    })
    const environmentHint = (help: string, value: unknown) =>
        `${help} ${t("installation.settings.environment_value", { value: value === undefined || value === "" ? t("installation.settings.unset") : String(value) })}`

    const sharingOptions = [
        { value: DEFAULT, label: t("installation.settings.use_environment", { value: t(`installation.settings.fields.sharing.options.${defaults.sharing}`) }) },
        { value: "domain", label: t("installation.settings.fields.sharing.options.domain") },
        { value: "conversation", label: t("installation.settings.fields.sharing.options.conversation") }
    ]
    const previewOptions = [
        {
            value: DEFAULT,
            label: t("installation.settings.use_environment", {
                value: t(defaults.previewsEnabled ? "installation.settings.fields.previewsEnabled.on" : "installation.settings.fields.previewsEnabled.off")
            })
        },
        { value: "on", label: t("installation.settings.fields.previewsEnabled.on") },
        { value: "off", label: t("installation.settings.fields.previewsEnabled.off") }
    ]

    const templateNames = new Set([...(templatesQuery.data ?? []).map(template => template.name), ...(summary.values.template ? [summary.values.template] : [])])
    const templateOptions = [
        { value: DEFAULT, label: t("installation.settings.use_environment", { value: defaults.template ?? t("installation.settings.fields.template.none") }) },
        ...[...templateNames].sort().map(name => ({ value: name, label: name }))
    ]

    return (
        <Card className="pt-4" data-testid="installation-sandbox-settings">
            <CardHeader>
                <CardTitle as="h2">{t("installation.settings.title")}</CardTitle>
                <CardDescription>
                    {t("installation.settings.description")}
                    {summary.updatedAt && ` ${t("installation.settings.updated_at", { time: format(new Date(summary.updatedAt), "PPp", { locale: themeStore.getLocale() }) })}`}
                </CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
                <Form {...form}>
                    <form onSubmit={form.handleSubmit(values => saveMutation.mutate(values))} className="flex flex-col gap-4">
                        <div className="grid gap-4 md:grid-cols-3">
                            {(Object.keys(NUMBER_FIELDS) as NumberField[]).map(field => (
                                <TextField<FormValues>
                                    key={field}
                                    name={field}
                                    type="number"
                                    min={NUMBER_FIELDS[field][0]}
                                    max={NUMBER_FIELDS[field][1]}
                                    step={1}
                                    label={t(`installation.settings.fields.${field}.label`)}
                                    placeholder={String(defaults[field])}
                                    description={environmentHint(t(`installation.settings.fields.${field}.help`), defaults[field])}
                                    rules={numberRules(field)}
                                    dataTestId={`installation-setting-${field}`}
                                />
                            ))}
                        </div>
                        <div className="grid gap-4 md:grid-cols-3">
                            {/* SelectField exposes no test id: the wrapper gives the tests a stable hook on the trigger. */}
                            <div data-testid="installation-setting-sharing">
                                <SelectField<FormValues>
                                    name="sharing"
                                    label={t("installation.settings.fields.sharing.label")}
                                    description={t("installation.settings.fields.sharing.help")}
                                    options={sharingOptions}
                                />
                            </div>
                            <div data-testid="installation-setting-previewsEnabled">
                                <SelectField<FormValues>
                                    name="previewsEnabled"
                                    label={t("installation.settings.fields.previewsEnabled.label")}
                                    description={t("installation.settings.fields.previewsEnabled.help")}
                                    options={previewOptions}
                                />
                            </div>
                            <TextField<FormValues>
                                name="previewUrl"
                                label={t("installation.settings.fields.previewUrl.label")}
                                placeholder={defaults.previewUrl ?? "https://*.sandbox.example.com"}
                                description={environmentHint(t("installation.settings.fields.previewUrl.help"), defaults.previewUrl)}
                                autoComplete="off"
                                rules={previewUrlRules}
                                dataTestId="installation-setting-previewUrl"
                            />
                        </div>

                        <Alert variant="warning" data-testid="installation-sandbox-reach-warning">
                            <ShieldAlert className="size-4" aria-hidden="true" />
                            <AlertTitle>{t("installation.settings.reach_warning.title")}</AlertTitle>
                            <AlertDescription>{t("installation.settings.reach_warning.description")}</AlertDescription>
                        </Alert>
                        <div data-testid="installation-setting-template">
                            <SelectField<FormValues>
                                name="template"
                                label={t("installation.settings.fields.template.label")}
                                description={environmentHint(t("installation.settings.fields.template.help"), defaults.template)}
                                options={templateOptions}
                            />
                        </div>
                        {TEXT_FIELDS.map(field => (
                            <TextField<FormValues>
                                key={field}
                                name={field}
                                label={t(`installation.settings.fields.${field}.label`)}
                                placeholder={defaults[field] ?? ""}
                                description={environmentHint(t(`installation.settings.fields.${field}.help`), defaults[field])}
                                autoComplete="off"
                                rules={textRules}
                                dataTestId={`installation-setting-${field}`}
                            />
                        ))}
                        <TextField<FormValues>
                            name="registryHosts"
                            label={t("installation.settings.fields.registryHosts.label")}
                            placeholder={defaults.registryHosts}
                            description={environmentHint(t("installation.settings.fields.registryHosts.help"), defaults.registryHosts)}
                            autoComplete="off"
                            rules={listRules(HOST, t("installation.settings.validation.hosts"))}
                            dataTestId="installation-setting-registryHosts"
                        />
                        <TextField<FormValues>
                            name="networkBinary"
                            label={t("installation.settings.fields.networkBinary.label")}
                            placeholder={defaults.networkBinary}
                            description={environmentHint(t("installation.settings.fields.networkBinary.help"), defaults.networkBinary)}
                            autoComplete="off"
                            rules={listRules(PATH, t("installation.settings.validation.paths"))}
                            dataTestId="installation-setting-networkBinary"
                        />

                        <div className="flex justify-end">
                            <Button type="submit" loading={saveMutation.isPending} loadingLabel={t("common.loading")} dataTestId="installation-sandbox-settings-save">
                                {t("common.save")}
                            </Button>
                        </div>
                    </form>
                </Form>
            </CardContent>
        </Card>
    )
}

export default SandboxSettingsForm
