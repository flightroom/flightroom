import { ColorSwatch, SectionHeader, SelectField, SwitchField as Switch, Tabs, TabsContent, TabsList, TabsTrigger, TextareaChipsField } from "@flightroom/design-system"
import { useMutation } from "@tanstack/react-query"
import { ExternalLink, FileText, Globe, LocateFixed, Lock, Moon, Shield, SlidersHorizontal, Trash2, TriangleAlert } from "lucide-react"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"
import { type FieldErrors, FormProvider, useForm, useFormContext } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Badge, Button } from "@/components/atoms"
import ColorPicker from "@/components/input/ColorPicker.rhf"
import TextareaField from "@/components/input/TextareaField.rhf"
import TextField from "@/components/input/TextField.rhf"
import useEnvironmentsApi, { EnvironmentDTO, KUBE_GREEN_DEFAULTS, type KubeGreenSettings, LOG_LEVELS, type LogLevel } from "@/hooks/apiClients/useEnvironmentsApi"
import { effectiveSubdomain } from "@/pages/backends/partials/backendVariables"
import useProjectStore from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import { cn } from "@/utils/styleUtils"

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
    kubeGreen?: KubeGreenSettings
}

/** Lunedi' per primo, come nel calendario italiano; 0 e' la domenica, come nel cron */
const WEEK = [1, 2, 3, 4, 5, 6, 0]

/** Come per il backend (isTimeZone): un fuso orario IANA che il browser riconosce */
const isTimeZone = (value: string) => {
    try {
        new Intl.DateTimeFormat("en", { timeZone: value })
        return value !== ""
    } catch {
        return false
    }
}

/** I fusi orari IANA del browser, suggeriti mentre si scrive; la lib ES2020 di TypeScript non conosce ancora supportedValuesOf */
const TIME_ZONES: string[] = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? []

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

/** Lo slug proposto dal nome, nella forma dei preset (DEV, PROD): maiuscole, cifre e trattini */
export const slugFromName = (name: string) =>
    name
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")

export const exposedHost = (domain: string, subdomain: string) => (subdomain ? `${subdomain}.${domain}` : domain)

/**
 * Gli orari di accensione di ogni giorno, uno per riga dal lunedi'. I giorni sono in ordine dalla domenica, quindi il
 * giorno e' anche l'indice nell'array del form.
 */
function DaysField() {
    const { t, i18n } = useTranslation()
    const { watch, getValues } = useFormContext<EnvironmentFormData>()
    // Il 4 gennaio 2026 e' una domenica: day giorni dopo cade il giorno day del cron
    const dayName = (day: number) => new Intl.DateTimeFormat(i18n.language, { weekday: "long" }).format(new Date(2026, 0, 4 + day))

    return (
        <div className="flex flex-col gap-2" data-testid="environment-kube-green-days">
            <div>
                <h4 className="text-sm font-medium text-foreground-secondary">{t("environment.form.kube_green.days")}</h4>
                <p className="text-sm text-foreground-secondary">{t("environment.form.kube_green.days_description")}</p>
            </div>
            {WEEK.map(day => {
                const isAwake = watch(`kubeGreen.days.${day}.awake`)
                return (
                    <div key={day} className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-border py-2 last:border-b-0">
                        <div className="flex-[0_0_180px] pt-1">
                            <Switch name={`kubeGreen.days.${day}.awake`} label={dayName(day).replace(/^./, first => first.toUpperCase())} dataTestId={`environment-kube-green-day-${day}-awake`} />
                        </div>
                        {isAwake ? (
                            <>
                                <TextField
                                    name={`kubeGreen.days.${day}.wakeUpAt`}
                                    type="time"
                                    dataTestId={`environment-kube-green-day-${day}-wake-up-at`}
                                    label={t("environment.form.kube_green.wake_up_at")}
                                    containerClassName="flex-[1_1_120px]"
                                />
                                <TextField
                                    name={`kubeGreen.days.${day}.sleepAt`}
                                    type="time"
                                    dataTestId={`environment-kube-green-day-${day}-sleep-at`}
                                    label={t("environment.form.kube_green.sleep_at")}
                                    rules={{
                                        deps: [`kubeGreen.days.${day}.wakeUpAt`],
                                        validate: sleepAt => {
                                            const wakeUpAt = getValues(`kubeGreen.days.${day}.wakeUpAt`)
                                            return !sleepAt || !wakeUpAt || wakeUpAt < sleepAt || t("environment.form.kube_green.sleep_at_before_wake_up")
                                        }
                                    }}
                                    containerClassName="flex-[1_1_120px]"
                                />
                            </>
                        ) : (
                            <p className="flex-[1_1_240px] pt-1 text-sm text-foreground-secondary">{t("environment.form.kube_green.asleep_all_day")}</p>
                        )}
                    </div>
                )
            })}
            <p className="text-sm text-foreground-secondary">{t("environment.form.kube_green.midnight_description")}</p>
        </div>
    )
}

/** Le schede dell'editor: una sezione alla volta, invece di tutti i campi in una pagina da scorrere */
type EditorTab = "general" | "exposure" | "network" | "logs" | "kubeGreen" | "danger"

/** I campi di ogni scheda: dicono quale scheda ha modifiche non salvate, e su quale portare chi salva con un errore */
const TAB_FIELDS: Record<Exclude<EditorTab, "danger">, (keyof EnvironmentFormData)[]> = {
    general: ["name", "slug", "description", "color", "isProduction", "domains"],
    exposure: ["namespace", "subdomain"],
    network: ["ipAllowList"],
    logs: ["logLevel", "logJson"],
    kubeGreen: ["kubeGreen"]
}

const TAB_ICONS: Record<EditorTab, ReactNode> = {
    general: <SlidersHorizontal />,
    exposure: <Globe />,
    network: <Shield />,
    logs: <FileText />,
    kubeGreen: <Moon />,
    danger: <TriangleAlert />
}

/** dirtyFields segna true le foglie cambiate, dentro oggetti e array che rispecchiano il form */
const hasDirty = (value: unknown): boolean => value === true || (typeof value === "object" && value !== null && Object.values(value).some(hasDirty))

/** Una sezione di una scheda: titolo e spiegazione a sinistra, i campi a destra */
function TabSection({ title, description, icon, children, dataTestId }: { title: string; description?: string; icon?: ReactNode; children: ReactNode; dataTestId?: string }) {
    return (
        <section className="grid gap-x-10 gap-y-4 lg:grid-cols-[240px_minmax(0,1fr)]" data-testid={dataTestId}>
            {/* In cima alla colonna: altrimenti la cella della griglia lo allinea all'altezza dei campi */}
            <div className="self-start">
                <SectionHeader as="h3" title={title} description={description} icon={icon} />
            </div>
            <div className="flex min-w-0 flex-col gap-4">{children}</div>
        </section>
    )
}

interface EnvironmentEditorProps {
    /** Valori di partenza: il genitore rimonta l'editor (key) quando cambia l'ambiente selezionato */
    formData: EnvironmentFormData
    id?: string
    onSaved: (environment: EnvironmentDTO) => Promise<void>
    /** Solo in creazione: in modifica "Annulla" riporta i valori salvati */
    onCancel?: () => void
    onDelete?: () => void
    /** Se il form ha modifiche non salvate: il genitore chiede conferma prima di aprire un altro ambiente */
    onDirtyChange?: (isDirty: boolean) => void
}

/**
 * Modifica dell'ambiente selezionato, in linea sotto le tessere invece che in un dialog. I campi sono divisi in
 * schede (generale, esposizione, rete, log, kube-green, zona pericolosa) per non scorrere tutta la pagina: le schede
 * nascoste restano montate, cosi' il form le valida e le salva tutte insieme.
 */
export function EnvironmentEditor({ formData, id, onSaved, onCancel, onDelete, onDirtyChange }: EnvironmentEditorProps) {
    const { t } = useTranslation()
    const isEdit = Boolean(id)
    // I campi di kube-green partono dai default anche per un ambiente salvato prima che ci fossero. Le liste partono vuote,
    // non undefined: svuotato, un campo a chip vale [] e "Annulla" lascerebbe il form diverso dal punto di partenza
    const form = useForm<EnvironmentFormData>({
        defaultValues: { ...formData, domains: formData.domains ?? [], ipAllowList: formData.ipAllowList ?? [], kubeGreen: { ...KUBE_GREEN_DEFAULTS, ...formData.kubeGreen } }
    })
    const environmentsApi = useEnvironmentsApi()
    const notifications = useToastNotificationStore()
    const timeZonesId = useId()
    const [tab, setTab] = useState<EditorTab>("general")
    // Il namespace serve solo a GitOps: senza, l'ambiente non finisce in nessun cluster
    const isGitOpsEnabled = Boolean(useProjectStore(state => state.project?.gitOps?.enabled))
    const name = form.watch("name")
    const slug = form.watch("slug")
    const color = form.watch("color")
    // Il sottodominio vale sul dominio del progetto: finche' non c'e', l'ambiente non e' esposto da GitOps
    const domain = useProjectStore(state => state.project?.exposure?.domain)
    const subdomain = form.watch("subdomain")
    const isProduction = form.watch("isProduction")
    const isKubeGreenEnabled = form.watch("kubeGreen.enabled")
    const { isSubmitting, isDirty, dirtyFields, errors } = form.formState
    // L'host e il namespace salvati, non quelli in modifica: l'intestazione mostra l'ambiente com'e' oggi
    const savedHost = isEdit && isGitOpsEnabled && domain ? exposedHost(domain, effectiveSubdomain(formData)) : undefined
    const savedNamespace = isEdit && isGitOpsEnabled ? formData.namespace || formData.slug.toLowerCase() : undefined

    // Senza GitOps i campi di esposizione, rete, log e kube-green non hanno effetto; eliminare vale solo per un ambiente salvato
    const tabs: EditorTab[] = ["general", ...(isGitOpsEnabled ? (["exposure", "network", "logs", "kubeGreen"] as const) : []), ...(isEdit ? (["danger"] as const) : [])]
    const isTabDirty = (value: EditorTab) => value !== "danger" && TAB_FIELDS[value].some(field => hasDirty(dirtyFields[field]))
    const isTabInvalid = (value: EditorTab) => value !== "danger" && TAB_FIELDS[value].some(field => field in errors)

    useEffect(() => {
        onDirtyChange?.(isDirty)
        return () => onDirtyChange?.(false)
    }, [isDirty, onDirtyChange])

    // In creazione lo slug segue il nome finche' l'utente non lo scrive a mano
    const derivedSlug = useRef(formData.slug)
    useEffect(() => {
        if (isEdit || form.getValues("slug") !== derivedSlug.current) return
        derivedSlug.current = slugFromName(name ?? "")
        // shouldDirty: cancellato il nome, lo slug torna vuoto e il form torna pulito
        form.setValue("slug", derivedSlug.current, { shouldDirty: true, shouldValidate: form.formState.isSubmitted })
    }, [isEdit, name, form])

    // L'indirizzo lo conosce solo il backend: il browser non vede il proprio IP pubblico
    const addMyIp = useMutation({
        mutationFn: environmentsApi.getClientIp,
        onSuccess: ip => {
            const current = form.getValues("ipAllowList") ?? []
            if (current.includes(ip)) {
                notifications.showInfoNotification({ message: t("environment.form.ip_allow_list_mine_present", { ip }) })
                return
            }
            form.setValue("ipAllowList", [...current, ip], { shouldDirty: true, shouldValidate: true })
        }
    })

    const onSubmit = async (data: EnvironmentFormData) => {
        const saved = isEdit ? await environmentsApi.editEnvironment(id, data) : await environmentsApi.createEnvironment(data)
        notifications.showSuccessNotification({
            message: t(isEdit ? "environment.update_success" : "environment.create_success")
        })
        // Quello appena salvato diventa il nuovo punto di partenza di "Annulla"
        form.reset(data)
        await onSaved(saved)
    }

    // Un errore in una scheda nascosta non si vedrebbe: si apre la prima scheda che ne ha uno
    const onInvalid = (invalid: FieldErrors<EnvironmentFormData>) => {
        const first = tabs.find(value => value !== "danger" && TAB_FIELDS[value].some(field => field in invalid))
        if (first) setTab(first)
    }

    return (
        // Niente card attorno: l'editor sta sullo sfondo della pagina, come la striscia degli ambienti sopra
        <div data-testid="environment-editor">
            <FormProvider {...form}>
                <form onSubmit={form.handleSubmit(onSubmit, onInvalid)}>
                    <div className="flex flex-row flex-wrap items-center gap-3">
                        <ColorSwatch size="md" color={color} />
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                            <div className="flex flex-wrap items-center gap-2">
                                <h2 className="text-xl font-semibold">{isEdit ? formData.name : t("environment.page.form.create_title")}</h2>
                                {isEdit && <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground-secondary">{formData.slug}</span>}
                                {isEdit && (
                                    <Badge variant={formData.isProduction ? "warning" : "outline"}>{t(formData.isProduction ? "environment.production" : "environment.page.not_production")}</Badge>
                                )}
                            </div>
                            {(savedHost || savedNamespace) && (
                                <p className="flex flex-wrap items-center gap-x-2 font-mono text-sm text-foreground-secondary">
                                    {savedHost && (
                                        <a
                                            href={`https://${savedHost}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1 text-primary-strong underline-offset-4 hover:underline"
                                        >
                                            {savedHost}
                                            <ExternalLink className="size-3.5" aria-hidden="true" />
                                            <span className="sr-only">{t("environment.page.opens_new_tab")}</span>
                                        </a>
                                    )}
                                    {savedHost && savedNamespace && <span aria-hidden="true">·</span>}
                                    {savedNamespace && <span className="text-foreground-secondary">{t("environment.page.namespace_label", { namespace: savedNamespace })}</span>}
                                </p>
                            )}
                        </div>
                    </div>
                    <div className="mt-5">
                        <Tabs value={tab} onValueChange={value => setTab(value as EditorTab)}>
                            <TabsList aria-label={t("environment.page.tabs.label")}>
                                {tabs.map(value => (
                                    <TabsTrigger
                                        key={value}
                                        value={value}
                                        dataTestId={`environment-tab-${value}`}
                                        className={cn(value === "danger" && "text-destructive data-[state=active]:text-destructive")}
                                    >
                                        {TAB_ICONS[value]}
                                        {t(`environment.page.tabs.${value}`)}
                                        {isTabInvalid(value) ? (
                                            <span className="size-2 rounded-full bg-destructive" title={t("environment.page.tabs.has_errors")} />
                                        ) : (
                                            isTabDirty(value) && <span className="size-2 rounded-full bg-primary" title={t("environment.page.form.unsaved")} />
                                        )}
                                    </TabsTrigger>
                                ))}
                            </TabsList>

                            {/* forceMount: i campi delle schede nascoste restano registrati, validati e inviati con gli altri */}
                            <TabsContent value="general" forceMount className="mt-6 data-[state=inactive]:hidden">
                                <TabSection title={t("environment.page.form.sections.general")} description={t("environment.page.form.descriptions.general")}>
                                    {/* Il testo dello slug va sotto il campo: fra etichetta e campo abbasserebbe lo slug rispetto al nome */}
                                    <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
                                        <TextField
                                            name="name"
                                            dataTestId="environment-name"
                                            label={t("environment.form.name")}
                                            placeholder={t("environment.form.name_placeholder")}
                                            rules={{
                                                required: t("environment.form.name_required") as string
                                            }}
                                            required
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
                                        />
                                        {isEdit && (
                                            <p className="flex items-center gap-1.5 text-sm text-foreground-secondary sm:col-start-2">
                                                <Lock className="size-3.5 shrink-0" aria-hidden="true" />
                                                {t("environment.form.slug_locked_description")}
                                            </p>
                                        )}
                                    </div>
                                    <TextareaField name="description" label={t("environment.form.description")} placeholder={t("environment.form.description_placeholder")} />
                                    <div className="flex flex-row flex-wrap justify-between gap-4">
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
                                    <TextareaChipsField
                                        name="domains"
                                        label={t("environment.form.domains")}
                                        placeholder={t("environment.form.domains_placeholder")}
                                        description={t("environment.form.domains_description")}
                                    />
                                </TabSection>
                            </TabsContent>

                            {isGitOpsEnabled && (
                                <TabsContent value="exposure" forceMount className="mt-6 data-[state=inactive]:hidden">
                                    <TabSection title={t("environment.page.form.sections.exposure")} description={t("environment.page.form.descriptions.exposure")}>
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
                                        />
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
                                        />
                                    </TabSection>
                                </TabsContent>
                            )}

                            {isGitOpsEnabled && (
                                <TabsContent value="network" forceMount className="mt-6 data-[state=inactive]:hidden">
                                    <TabSection title={t("environment.page.form.sections.network")} description={t("environment.page.form.descriptions.network")}>
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
                                        <div>
                                            <Button
                                                type="button"
                                                variant="secondary"
                                                onClick={() => addMyIp.mutate()}
                                                loading={addMyIp.isPending}
                                                loadingLabel={t("environment.form.ip_allow_list_add_mine")}
                                                dataTestId="environment-ip-allow-list-add-mine"
                                            >
                                                <LocateFixed />
                                                {t("environment.form.ip_allow_list_add_mine")}
                                            </Button>
                                        </div>
                                    </TabSection>
                                </TabsContent>
                            )}

                            {isGitOpsEnabled && (
                                <TabsContent value="logs" forceMount className="mt-6 data-[state=inactive]:hidden">
                                    <TabSection title={t("environment.page.form.sections.logs")} description={t("environment.page.form.descriptions.logs")}>
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
                                    </TabSection>
                                </TabsContent>
                            )}

                            {isGitOpsEnabled && (
                                <TabsContent value="kubeGreen" forceMount className="mt-6 data-[state=inactive]:hidden">
                                    <TabSection
                                        title={t("environment.page.form.sections.kube_green")}
                                        description={t("environment.form.kube_green.description")}
                                        icon={<img src="/img/kube-green.svg" alt="" className="size-5" />}
                                        dataTestId="environment-kube-green"
                                    >
                                        <Switch name="kubeGreen.enabled" label={t("environment.form.kube_green.enabled")} />
                                        {isKubeGreenEnabled && (
                                            <>
                                                <DaysField />
                                                <TextField
                                                    name="kubeGreen.timeZone"
                                                    dataTestId="environment-kube-green-time-zone"
                                                    label={t("environment.form.kube_green.time_zone")}
                                                    placeholder="Europe/Rome"
                                                    list={timeZonesId}
                                                    autoComplete="off"
                                                    rules={{ validate: value => isTimeZone((value ?? "").trim()) || t("environment.form.kube_green.time_zone_invalid") }}
                                                    required
                                                />
                                                <datalist id={timeZonesId}>
                                                    {TIME_ZONES.map(timeZone => (
                                                        <option key={timeZone} value={timeZone} />
                                                    ))}
                                                </datalist>
                                                <div className="flex flex-col gap-3">
                                                    <Switch name="kubeGreen.suspendDeployments" label={t("environment.form.kube_green.suspend_deployments")} />
                                                    <Switch name="kubeGreen.suspendStatefulSets" label={t("environment.form.kube_green.suspend_stateful_sets")} />
                                                    <Switch name="kubeGreen.suspendCronJobs" label={t("environment.form.kube_green.suspend_cron_jobs")} />
                                                </div>
                                                <TextareaChipsField
                                                    name="kubeGreen.excludeApplications"
                                                    dataTestId="environment-kube-green-exclude"
                                                    label={t("environment.form.kube_green.exclude_applications")}
                                                    placeholder={t("environment.form.kube_green.exclude_applications_placeholder")}
                                                    description={t("environment.form.kube_green.exclude_applications_description")}
                                                    textTransform={value => value.trim()}
                                                />
                                            </>
                                        )}
                                    </TabSection>
                                </TabsContent>
                            )}

                            {isEdit && (
                                <TabsContent value="danger" className="mt-6">
                                    <div className="overflow-hidden rounded-lg border-2 border-destructive/40">
                                        <p className="flex items-center gap-2 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive">
                                            <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
                                            {t("environment.page.danger.warning")}
                                        </p>
                                        <div className="flex flex-wrap items-center justify-between gap-4 p-4">
                                            <div className="min-w-0 flex-[1_1_280px]">
                                                <h3 className="font-semibold text-destructive">{t("environment.page.delete.title")}</h3>
                                                <p className="text-sm text-foreground-secondary">
                                                    {t(formData.isProduction ? "environment.page.danger.delete_production_description" : "environment.page.danger.delete_description", {
                                                        name: formData.name
                                                    })}
                                                </p>
                                            </div>
                                            <Button type="button" variant="destructive" onClick={onDelete} disabled={isSubmitting} dataTestId={`environment-delete-${formData.slug}`}>
                                                <Trash2 />
                                                {t("environment.page.form.delete")}
                                            </Button>
                                        </div>
                                    </div>
                                </TabsContent>
                            )}
                        </Tabs>
                    </div>
                    {/* La zona pericolosa non ha campi da salvare */}
                    {tab !== "danger" && (
                        <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t-2 border-border pt-4">
                            {isDirty ? (
                                <span className="flex items-center gap-2 text-sm font-medium text-foreground-secondary">
                                    <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
                                    {t("environment.page.form.unsaved")}
                                </span>
                            ) : (
                                <span />
                            )}
                            <div className="flex gap-2">
                                <Button
                                    type="button"
                                    variant="secondary"
                                    // In modifica riporta i valori salvati, in creazione torna all'ambiente di prima
                                    onClick={isEdit ? () => form.reset() : onCancel}
                                    disabled={isSubmitting || (isEdit && !isDirty)}
                                >
                                    {t("environment.page.form.cancel")}
                                </Button>
                                {/* In creazione resta cliccabile anche vuoto: e' l'invio che mostra quali campi mancano */}
                                <Button type="submit" loading={isSubmitting} loadingLabel={t("common.saving")} disabled={isEdit && !isDirty} dataTestId="environment-submit">
                                    {isEdit ? t("environment.page.form.update") : t("environment.page.form.create")}
                                </Button>
                            </div>
                        </div>
                    )}
                </form>
            </FormProvider>
        </div>
    )
}

export default EnvironmentEditor
