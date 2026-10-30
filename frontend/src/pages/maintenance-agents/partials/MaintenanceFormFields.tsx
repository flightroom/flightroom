import { Card, CardContent, CardDescription, CardHeader, CardTitle, Popover, PopoverContent, PopoverTrigger, RadioGroup, RadioGroupItem, SearchInput } from "@flightroom/design-system"
import { Plus, X } from "lucide-react"
import { useState } from "react"
import { Controller, useFormContext, useWatch } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import TextField from "@/components/input/TextField.rhf"
import type { MaintenanceAgentKind } from "@/hooks/apiClients/useMaintenanceAgentsApi"
import ContainerResourceFields from "@/pages/backends/partials/ContainerResourceFields"
import EnvironmentVersionFields from "@/pages/backends/partials/EnvironmentVersionFields"
import useProjectStore from "@/store/useProjectStore"
import { cn } from "@/utils/styleUtils"
import { KindGlyph } from "./MaintenanceBadges"
import { describeCron, isValidCron, SCHEDULE_PRESETS, type ScheduleMode } from "./maintenance"

const KINDS: MaintenanceAgentKind[] = ["container", "job"]
const SCHEDULE_MODES: ScheduleMode[] = ["manual", "hourly", "daily", "weekly", "custom"]

/** Container or job: it decides whether the agent has a port, probes and a run path */
export const MaintenanceKindField: React.FC = () => {
    const { t } = useTranslation()
    const { control } = useFormContext()

    return (
        <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-semibold">{t("maintenance.kind.label")}</legend>
            <Controller
                control={control}
                name="kind"
                render={({ field }) => (
                    <RadioGroup value={field.value} onValueChange={field.onChange} className="flex flex-wrap gap-3">
                        {KINDS.map(kind => (
                            <label
                                key={kind}
                                htmlFor={`maintenance-kind-${kind}`}
                                className={cn(
                                    "flex flex-[1_1_240px] cursor-pointer items-start gap-3 rounded-md border-2 border-border p-3 transition-colors",
                                    field.value === kind && "border-primary bg-primary/5"
                                )}
                            >
                                <RadioGroupItem id={`maintenance-kind-${kind}`} value={kind} className="mt-0.5" />
                                <KindGlyph kind={kind} className="mt-0.5 size-5 text-foreground" />
                                <span className="min-w-0">
                                    <span className="block text-sm font-semibold">{t(`maintenance.kind.${kind}`)}</span>
                                    <span className="block text-xs text-foreground-secondary">{t(`maintenance.kind.${kind}_description`)}</span>
                                </span>
                            </label>
                        ))}
                    </RadioGroup>
                )}
            />
        </fieldset>
    )
}

/** When it runs: never by itself, one of the presets or any cron, in a time zone */
export const MaintenanceScheduleFields: React.FC = () => {
    const { t, i18n } = useTranslation()
    const { control, setValue } = useFormContext()
    const [mode, schedule] = useWatch({ name: ["scheduleMode", "schedule"] }) as [ScheduleMode, string | undefined]
    const preview = mode === "custom" && schedule?.trim() && isValidCron(schedule) ? (describeCron(schedule, t, i18n.language) ?? t("maintenance.schedule.custom_preview_raw")) : undefined

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("maintenance.schedule.title")}</CardTitle>
                <CardDescription>{t("maintenance.schedule.description")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 pt-3">
                <Controller
                    control={control}
                    name="scheduleMode"
                    render={({ field }) => (
                        <RadioGroup
                            value={field.value}
                            onValueChange={value => {
                                field.onChange(value)
                                // A preset writes its cron, so switching to custom starts from it
                                if (value in SCHEDULE_PRESETS) setValue("schedule", SCHEDULE_PRESETS[value as keyof typeof SCHEDULE_PRESETS], { shouldDirty: true })
                            }}
                            aria-label={t("maintenance.schedule.label")}
                            className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,170px),1fr))] gap-3"
                        >
                            {SCHEDULE_MODES.map(option => (
                                <label
                                    key={option}
                                    htmlFor={`maintenance-schedule-${option}`}
                                    className={cn(
                                        "flex cursor-pointer items-start gap-3 rounded-md border-2 border-border p-3 transition-colors",
                                        field.value === option && "border-primary bg-primary/5"
                                    )}
                                >
                                    <RadioGroupItem id={`maintenance-schedule-${option}`} value={option} className="mt-0.5" />
                                    <span className="min-w-0">
                                        <span className="block text-sm font-semibold">{t(`maintenance.schedule.mode_${option}`)}</span>
                                        <span className="block text-xs text-foreground-secondary">
                                            {option in SCHEDULE_PRESETS
                                                ? describeCron(SCHEDULE_PRESETS[option as keyof typeof SCHEDULE_PRESETS], t, i18n.language)
                                                : t(`maintenance.schedule.mode_${option}_hint`)}
                                        </span>
                                    </span>
                                </label>
                            ))}
                        </RadioGroup>
                    )}
                />
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {mode === "custom" && (
                        <TextField
                            name="schedule"
                            label={t("maintenance.schedule.cron")}
                            placeholder="*/15 * * * *"
                            description={preview ? t("maintenance.schedule.custom_preview", { description: preview }) : t("maintenance.schedule.cron_hint")}
                            className="font-mono"
                            autoComplete="off"
                            required
                            containerClassName="flex-[1_1_240px]"
                        />
                    )}
                    {mode !== "manual" && (
                        <TextField
                            name="timeZone"
                            label={t("maintenance.schedule.time_zone")}
                            placeholder="Europe/Rome"
                            description={t("maintenance.schedule.time_zone_hint")}
                            autoComplete="off"
                            containerClassName="flex-[1_1_240px]"
                        />
                    )}
                </div>
            </CardContent>
        </Card>
    )
}

interface TargetOption {
    _id?: string
    name: string
    slug: string
}

/** The members of one kind the agent maintains, each removable, and a search to add the others */
export const MaintenanceTargetPicker: React.FC<{ name: "backendIds" | "frontendIds"; options: TargetOption[]; title: string; dotClassName: string }> = ({ name, options, title, dotClassName }) => {
    const { t } = useTranslation()
    const { control } = useFormContext()
    const [open, setOpen] = useState(false)
    const [searchTerm, setSearchTerm] = useState("")

    return (
        <fieldset className="flex min-w-0 flex-[1_1_280px] flex-col gap-2">
            <legend className="mb-2 text-sm font-semibold">{title}</legend>
            {options.length === 0 ? (
                <p className="text-sm text-foreground-secondary">{t("maintenance.targets.no_options")}</p>
            ) : (
                <Controller
                    control={control}
                    name={name}
                    render={({ field }) => {
                        const selected: string[] = field.value ?? []
                        const attached = options.filter(option => selected.includes(option._id!))
                        const term = searchTerm.trim().toLowerCase()
                        const candidates = options.filter(option => !selected.includes(option._id!) && (!term || option.name.toLowerCase().includes(term) || option.slug.toLowerCase().includes(term)))
                        const allAttached = attached.length === options.length

                        return (
                            <div className="flex flex-col gap-2">
                                {attached.length > 0 && (
                                    <ul className="flex flex-col divide-y divide-divider rounded-md border border-divider">
                                        {attached.map(option => (
                                            <li key={option._id} className="flex items-center gap-3 py-2 pl-3 pr-2">
                                                <span className={cn("size-2.5 shrink-0 rounded-full", dotClassName)} aria-hidden="true" />
                                                <div className="min-w-0 flex-1">
                                                    <span className="block truncate text-sm font-medium">{option.name}</span>
                                                    <span className="block truncate font-mono text-xs text-foreground-secondary">{option.slug}</span>
                                                </div>
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="icon-sm"
                                                    aria-label={t("maintenance.targets.remove", { name: option.name })}
                                                    title={t("maintenance.targets.remove", { name: option.name })}
                                                    onClick={() => field.onChange(selected.filter(id => id !== option._id))}
                                                >
                                                    <X />
                                                </Button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                <Popover
                                    open={open}
                                    onOpenChange={next => {
                                        setOpen(next)
                                        if (!next) setSearchTerm("")
                                    }}
                                >
                                    <PopoverTrigger asChild>
                                        <Button type="button" variant="secondary" size="sm" className="self-start" disabled={allAttached}>
                                            <Plus />
                                            {allAttached ? t("maintenance.targets.all_added") : t("maintenance.targets.add")}
                                        </Button>
                                    </PopoverTrigger>
                                    <PopoverContent align="start" className="flex w-80 flex-col gap-2 p-2">
                                        <SearchInput
                                            autoFocus
                                            value={searchTerm}
                                            onValueChange={setSearchTerm}
                                            onClear={() => setSearchTerm("")}
                                            clearLabel={t("maintenance.targets.clear_search")}
                                            placeholder={t("maintenance.targets.search_placeholder")}
                                        />
                                        {candidates.length > 0 ? (
                                            <ul className="flex max-h-64 flex-col overflow-y-auto">
                                                {candidates.map(option => (
                                                    <li key={option._id}>
                                                        <button
                                                            type="button"
                                                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-primary/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                                            onClick={() => {
                                                                field.onChange([...selected, option._id!])
                                                                setOpen(false)
                                                                setSearchTerm("")
                                                            }}
                                                        >
                                                            <span className={cn("size-2 shrink-0 rounded-full", dotClassName)} aria-hidden="true" />
                                                            <span className="min-w-0">
                                                                <span className="block truncate text-sm font-medium">{option.name}</span>
                                                                <span className="block truncate font-mono text-xs text-foreground-secondary">{option.slug}</span>
                                                            </span>
                                                        </button>
                                                    </li>
                                                ))}
                                            </ul>
                                        ) : (
                                            <p className="px-2 py-4 text-center text-sm text-foreground-secondary">{t("maintenance.targets.no_results", { searchTerm })}</p>
                                        )}
                                    </PopoverContent>
                                </Popover>
                            </div>
                        )
                    }}
                />
            )}
        </fieldset>
    )
}

/** The image, the version, the CPU and the memory, and for a container its port, probes and the endpoint a run calls */
export const MaintenanceRuntimeFields: React.FC = () => {
    const { t } = useTranslation()
    const { watch } = useFormContext()
    const containerRegistry = useProjectStore(state => state.project?.containerRegistry)
    const isContainer = watch("kind") === "container"

    // Left empty, the deploy takes the image from the registry of the project: say which one, or that a version would not be deployed
    // A bare name, with no "/", is an image of that registry too
    const image = watch("image.repository")?.trim()
    const hasVersion = Boolean(watch("version")?.trim())
    const imageHint = image?.includes("/")
        ? t("backends.image_repository_hint")
        : containerRegistry
          ? t(image ? "backends.image_repository_hint_name" : "backends.image_repository_hint_registry", { image: `${containerRegistry}/${image || watch("slug") || "<slug>"}` })
          : !image && hasVersion
            ? t("backends.image_repository_missing")
            : t("backends.image_repository_hint")

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("backends.runtime_settings")}</CardTitle>
                <CardDescription>{isContainer ? t("maintenance.runtime.container_description") : t("maintenance.runtime.job_description")}</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-x-4 gap-y-2 pt-3 md:grid-cols-2">
                <TextField name="image.repository" label={t("backends.image_repository")} placeholder="ghcr.io/acme/cleanup-agent" description={imageHint} />
                <TextField name="version" label={t("backends.version")} placeholder="1.0.0" description={t("backends.version_hint")} />
                <EnvironmentVersionFields className="md:col-span-2" />
                {isContainer && (
                    <>
                        <TextField name="runPath" label={t("maintenance.run_path")} placeholder="/run" description={t("maintenance.run_path_hint")} required />
                        <TextField name="port" type="number" label={t("backends.port")} required />
                        <TextField name="livenessPath" label={t("backends.liveness_path")} placeholder="/health/live" description={t("backends.liveness_path_hint")} required />
                        <TextField name="readinessPath" label={t("backends.readiness_path")} placeholder="/health/ready" description={t("backends.readiness_path_hint")} required />
                    </>
                )}
                {/* A job's too: its CronJob runs the image with them */}
                <ContainerResourceFields />
            </CardContent>
        </Card>
    )
}
