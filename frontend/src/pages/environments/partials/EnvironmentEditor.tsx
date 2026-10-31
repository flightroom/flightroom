import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, SectionHeader, SelectField, SwitchField as Switch, TextareaChipsField } from "@flightroom/design-system"
import { ExternalLink, Trash2 } from "lucide-react"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import ColorPicker from "@/components/input/ColorPicker.rhf"
import TextareaField from "@/components/input/TextareaField.rhf"
import TextField from "@/components/input/TextField.rhf"
import useEnvironmentsApi, { EnvironmentDTO, LOG_LEVELS, type LogLevel } from "@/hooks/apiClients/useEnvironmentsApi"
import { effectiveSubdomain } from "@/pages/backends/partials/backendVariables"
import useProjectStore from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"

export interface EnvironmentFormData {
    name: string
    slug: string
    description?: string
    color?: string
    isProduction?: boolean
    domains?: string[]
    namespace?: string
    subdomain?: string
    ipAllowList?: string[]
    logLevel?: LogLevel
    logJson?: boolean
}

/** Come per il backend: etichette DNS separate da punti, oppure niente per il dominio stesso */
const SUBDOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*)?$/

const IPV4 = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

/** Il parser degli URL del browser riconosce un IPv6 fra parentesi quadre: prima si scartano parentesi, zone e tutto ciò che chiuderebbe l'host */
const isIpv6 = (address: string) => {
    if (!address.includes(":") || !/^[0-9a-fA-F:.]+$/.test(address)) return false
    try {
        return new URL(`http://[${address}]`).hostname !== ""
    } catch {
        return false
    }
}

/** Come per il backend (isIpRange): un indirizzo IPv4 o IPv6, con o senza il prefisso CIDR */
const isIpRange = (value: string) => {
    const [address, prefix, ...rest] = value.split("/")
    const isV4 = IPV4.test(address)
    if ((!isV4 && !isIpv6(address)) || rest.length > 0) return false
    return prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= (isV4 ? 32 : 128))
}

/** Come per il backend (IP_ALLOW_LIST_MAX) */
const IP_ALLOW_LIST_MAX = 100

export const exposedHost = (domain: string, subdomain: string) => (subdomain ? `${subdomain}.${domain}` : domain)

interface EnvironmentEditorProps {
    /** Valori di partenza: il genitore rimonta l'editor (key) quando cambia l'ambiente selezionato */
    formData: EnvironmentFormData
    id?: string
    onSaved: (environment: EnvironmentDTO) => Promise<void>
    /** Solo in creazione: in modifica "Annulla" riporta i valori salvati */
    onCancel?: () => void
    onDelete?: () => void
}

/**
 * Modifica dell'ambiente selezionato, in linea sotto le tessere invece che in un dialog:
 * i campi crescono con GitOps (esposizione, IP, log) e su due colonne restano tutti a vista.
 */
export function EnvironmentEditor({ formData, id, onSaved, onCancel, onDelete }: EnvironmentEditorProps) {
    const { t } = useTranslation()
    const isEdit = Boolean(id)
    const form = useForm<EnvironmentFormData>({ defaultValues: formData })
    const environmentsApi = useEnvironmentsApi()
    const notifications = useToastNotificationStore()
    // Il namespace serve solo a GitOps: senza, l'ambiente non finisce in nessun cluster
    const isGitOpsEnabled = Boolean(useProjectStore(state => state.project?.gitOps?.enabled))
    const slug = form.watch("slug")
    // Il sottodominio vale sul dominio del progetto: finche' non c'e', l'ambiente non e' esposto da GitOps
    const domain = useProjectStore(state => state.project?.exposure?.domain)
    const subdomain = form.watch("subdomain")
    const isProduction = form.watch("isProduction")
    const isSubmitting = form.formState.isSubmitting
    // L'host salvato, non quello in modifica: il link porta all'ambiente com'e' oggi
    const savedHost = isEdit && isGitOpsEnabled && domain ? exposedHost(domain, effectiveSubdomain(formData)) : undefined

    const onSubmit = async (data: EnvironmentFormData) => {
        const saved = isEdit ? await environmentsApi.editEnvironment(id, data) : await environmentsApi.createEnvironment(data)
        notifications.showSuccessNotification({
            message: t(isEdit ? "environment.update_success" : "environment.create_success")
        })
        // Quello appena salvato diventa il nuovo punto di partenza di "Annulla"
        form.reset(data)
        await onSaved(saved)
    }

    return (
        <Card dataTestId="environment-editor">
            <FormProvider {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)}>
                    <CardHeader>
                        <CardTitle as="h2" className="mb-0">
                            {isEdit ? t("environment.page.form.edit_title", { name: formData.name }) : t("environment.page.form.create_title")}
                        </CardTitle>
                        {savedHost && (
                            <CardDescription>
                                <a
                                    href={`https://${savedHost}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 font-mono text-primary-strong underline-offset-4 hover:underline"
                                >
                                    {savedHost}
                                    <ExternalLink className="size-3.5" aria-hidden="true" />
                                    <span className="sr-only">{t("environment.page.opens_new_tab")}</span>
                                </a>
                            </CardDescription>
                        )}
                    </CardHeader>
                    <CardContent className="grid gap-x-8 gap-y-6 pt-3 lg:grid-cols-2">
                        <section className="flex flex-col gap-4">
                            <SectionHeader as="h3" title={t("environment.page.form.sections.general")} />
                            <div className="flex flex-wrap gap-x-4 gap-y-2">
                                <TextField
                                    name="name"
                                    dataTestId="environment-name"
                                    label={t("environment.form.name")}
                                    placeholder={t("environment.form.name_placeholder")}
                                    rules={{
                                        required: t("environment.form.name_required") as string
                                    }}
                                    required
                                    containerClassName="flex-[1_1_200px]"
                                />
                                <TextField
                                    name="slug"
                                    dataTestId="environment-slug"
                                    label={t("environment.form.slug")}
                                    placeholder={t("environment.form.slug_placeholder")}
                                    rules={{
                                        required: t("environment.form.slug_required") as string
                                    }}
                                    disabled={isEdit}
                                    required
                                    containerClassName="flex-[1_1_200px]"
                                />
                            </div>
                            <TextareaField name="description" label={t("environment.form.description")} placeholder={t("environment.form.description_placeholder")} />
                            <div className="flex flex-row justify-between gap-4">
                                <ColorPicker
                                    name="color"
                                    label={t("environment.color")}
                                    rules={{
                                        required: t("environment.form.color_required") as string
                                    }}
                                    required
                                />
                                <Switch name="isProduction" label={t("environment.is_production")} />
                            </div>
                        </section>

                        <div className="flex flex-col gap-6">
                            <section className="flex flex-col gap-4">
                                <SectionHeader as="h3" title={t("environment.page.form.sections.exposure")} />
                                {isGitOpsEnabled && (
                                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                                        <TextField
                                            name="namespace"
                                            dataTestId="environment-namespace"
                                            label={t("environment.form.namespace")}
                                            placeholder={slug?.toLowerCase() || t("environment.form.namespace_placeholder")}
                                            description={t("environment.form.namespace_description")}
                                            rules={{
                                                pattern: {
                                                    value: /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)?$/,
                                                    message: t("environment.form.namespace_invalid")
                                                }
                                            }}
                                            containerClassName="flex-[1_1_200px]"
                                        />
                                        <TextField
                                            name="subdomain"
                                            dataTestId="environment-subdomain"
                                            label={t("environment.form.subdomain")}
                                            placeholder={t("environment.form.subdomain_placeholder")}
                                            description={
                                                domain
                                                    ? t("environment.form.subdomain_description", {
                                                          host: exposedHost(domain, effectiveSubdomain({ slug: slug ?? "", subdomain: subdomain?.trim().toLowerCase(), isProduction }))
                                                      })
                                                    : t("environment.form.subdomain_description_no_domain")
                                            }
                                            // Il backend toglie gli spazi e porta in minuscolo: qui si controlla quello che salverà
                                            rules={{ validate: value => SUBDOMAIN.test((value ?? "").trim().toLowerCase()) || t("environment.form.subdomain_invalid") }}
                                            containerClassName="flex-[1_1_200px]"
                                        />
                                    </div>
                                )}
                                {isGitOpsEnabled && (
                                    <TextareaChipsField
                                        name="ipAllowList"
                                        dataTestId="environment-ip-allow-list"
                                        label={t("environment.form.ip_allow_list")}
                                        placeholder={t("environment.form.ip_allow_list_placeholder")}
                                        description={domain ? t("environment.form.ip_allow_list_description") : t("environment.form.ip_allow_list_description_no_domain")}
                                        textTransform={value => value.trim()}
                                        rules={{
                                            validate: (ranges?: string[]) => {
                                                const invalid = ranges?.find(range => !isIpRange(range))
                                                if (invalid !== undefined) return t("environment.form.ip_allow_list_invalid", { value: invalid })
                                                return (ranges?.length ?? 0) <= IP_ALLOW_LIST_MAX || t("environment.form.ip_allow_list_too_long", { max: IP_ALLOW_LIST_MAX })
                                            }
                                        }}
                                    />
                                )}
                                <TextareaChipsField name="domains" label={t("environment.form.domains")} placeholder={t("environment.form.domains_placeholder")} />
                            </section>

                            {isGitOpsEnabled && (
                                <section className="flex flex-col gap-4">
                                    <SectionHeader as="h3" title={t("environment.page.form.sections.logs")} />
                                    <div className="flex flex-row flex-wrap items-start justify-between gap-4">
                                        {/* SelectField non espone un test id: il wrapper dà ai test un aggancio stabile sul trigger. */}
                                        <div data-testid="environment-log-level" className="flex-[1_1_200px]">
                                            <SelectField
                                                name="logLevel"
                                                label={t("environment.form.log_level")}
                                                description={t("environment.form.log_level_description")}
                                                options={LOG_LEVELS.map(level => ({ value: level, label: t(`environment.form.log_levels.${level}`) }))}
                                            />
                                        </div>
                                        <Switch name="logJson" label={t("environment.form.log_json")} description={t("environment.form.log_json_description")} />
                                    </div>
                                </section>
                            )}
                        </div>
                    </CardContent>
                    <CardFooter className="flex flex-wrap justify-between gap-2">
                        {isEdit ? (
                            <Button
                                type="button"
                                variant="ghost"
                                className="text-destructive hover:bg-destructive/15 hover:text-destructive-active"
                                onClick={onDelete}
                                disabled={isSubmitting}
                                dataTestId={`environment-delete-${formData.slug}`}
                            >
                                <Trash2 />
                                {t("environment.page.form.delete")}
                            </Button>
                        ) : (
                            <span />
                        )}
                        <div className="flex gap-2">
                            <Button
                                type="button"
                                variant="secondary"
                                // In modifica riporta i valori salvati, in creazione torna all'ambiente di prima
                                onClick={isEdit ? () => form.reset() : onCancel}
                                disabled={isSubmitting || (isEdit && !form.formState.isDirty)}
                            >
                                {t("environment.page.form.cancel")}
                            </Button>
                            <Button type="submit" disabled={isSubmitting} dataTestId="environment-submit">
                                {isEdit ? t("environment.page.form.update") : t("environment.page.form.create")}
                            </Button>
                        </div>
                    </CardFooter>
                </form>
            </FormProvider>
        </Card>
    )
}

export default EnvironmentEditor
