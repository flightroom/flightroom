import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Spinner, StatTile, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { format, parseISO } from "date-fns"
import { Box } from "lucide-react"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, TooltipContentProps, XAxis, YAxis } from "recharts"
import useAiUsageApi, {
    AI_USAGE_QUERY_KEY,
    AiUsagePeriod,
    AiUsageTarget,
    OrganizationAiUsageSummary,
    ProjectAiUsageSummary,
    SandboxCodingDay,
    SandboxUsageSource,
    SandboxUsageTotals
} from "@/hooks/apiClients/useAiUsageApi"
import useThemeStore from "@/store/useThemeStore"
import { cn } from "@/utils/styleUtils"
import AiUsagePeriodSelect from "./AiUsagePeriodSelect"

const SOURCES: SandboxUsageSource[] = ["agent", "mission", "preview"]

const DAY_MS = 24 * 60 * 60 * 1000

const isoDay = (date: Date) => date.toISOString().slice(0, 10)

/**
 * Every UTC day from the first counted to today, the days the AI ran nothing at zero: a bar chart with gaps closed
 * would read as steady work. With no start (all time) the series starts on its first day.
 */
export const everyDay = (codingByDay: SandboxCodingDay[], since: string | undefined, now = new Date()): SandboxCodingDay[] => {
    const first = since ? isoDay(new Date(since)) : codingByDay[0]?.day
    if (!first) return []
    const seconds = new Map(codingByDay.map(day => [day.day, day.execSeconds]))
    const days: SandboxCodingDay[] = []
    for (let time = Date.parse(first), last = Date.parse(isoDay(now)); time <= last; time += DAY_MS) {
        const day = isoDay(new Date(time))
        days.push({ day, execSeconds: seconds.get(day) ?? 0 })
    }
    return days
}

interface SandboxUsageCardProps {
    target: AiUsageTarget
}

interface BreakdownRow extends SandboxUsageTotals {
    key: string
    label: string
}

/**
 * The time spent in sandboxes over a period on what the page shows: how long the scripts and commands ran, how long
 * the sandboxes lived, idle minutes included, and a chart of the minutes the AI spent running code each day. The
 * project adds the split between Edit with AI, the missions and the live previews, the organization the split by
 * project. Read from the same summary as the AI tokens: one request when both cards show the same period.
 */
const SandboxUsageCard: React.FC<SandboxUsageCardProps> = ({ target }) => {
    const { t, i18n } = useTranslation()
    const themeStore = useThemeStore()
    const aiUsageApi = useAiUsageApi()
    const [period, setPeriod] = useState<AiUsagePeriod>("30d")

    const usageQuery = useQuery({
        queryKey: [AI_USAGE_QUERY_KEY, target.kind, target.id, period],
        queryFn: () => aiUsageApi.get(target, period),
        placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === target.kind && previousQuery?.queryKey[2] === target.id ? previous : undefined)
    })

    const usage = usageQuery.data
    const sandbox = usage?.sandbox
    const minutes = (seconds: number) => (seconds / 60).toLocaleString(i18n.language, { maximumFractionDigits: 1 })
    // A few short commands round to 0, which would read as nothing ran
    const minutesValue = (seconds: number) => (seconds > 0 && minutes(seconds) === minutes(0) ? t("sandbox_usage.under_minute") : t("sandbox_usage.minutes_value", { minutes: minutes(seconds) }))

    const days = useMemo(() => (usage && sandbox ? everyDay(sandbox.codingByDay ?? [], usage.since) : []), [usage, sandbox])
    const chartData = days.map(day => ({ day: day.day, minutes: Number((day.execSeconds / 60).toFixed(1)) }))
    const dayLabel = (day: string, pattern: string) => format(parseISO(day), pattern, { locale: themeStore.getLocale() })

    const breakdown: BreakdownRow[] | undefined =
        usage && sandbox && "byProject" in usage
            ? (usage as OrganizationAiUsageSummary).byProject
                  .filter(project => project.sandbox.commands + project.sandbox.lifetimeSeconds > 0)
                  .map(project => ({ key: project.projectId, label: project.name ?? t("ai_usage.deleted_project"), ...project.sandbox }))
                  .sort((a, b) => b.execSeconds - a.execSeconds || b.lifetimeSeconds - a.lifetimeSeconds)
            : usage && sandbox && "bySource" in usage
              ? SOURCES.map(source => ({ key: source, label: t(`ai_usage.sources.${source}`), ...(usage as ProjectAiUsageSummary).sandbox.bySource[source] }))
              : undefined
    const isEmpty = sandbox ? sandbox.total.commands + sandbox.total.execSeconds + sandbox.total.lifetimeSeconds === 0 : false
    const codedSomething = days.some(day => day.execSeconds > 0)

    const renderTooltip = ({ active, payload }: TooltipContentProps<number, string>) => {
        const point = active ? (payload?.[0]?.payload as { day: string; minutes: number } | undefined) : undefined
        if (!point) return null
        return (
            <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
                <div className="font-medium">{dayLabel(point.day, "PPP")}</div>
                <div className="tabular-nums text-foreground-secondary">{t("sandbox_usage.minutes_value", { minutes: point.minutes.toLocaleString(i18n.language) })}</div>
            </div>
        )
    }

    return (
        <Card data-testid={`sandbox-usage-${target.kind}`}>
            <CardHeader className="flex-row items-start justify-between gap-3">
                <div className="min-w-0">
                    <CardTitle className="mb-0 flex items-center gap-2">
                        <Box className="size-5" aria-hidden="true" />
                        {t("sandbox_usage.title")}
                    </CardTitle>
                    <CardDescription>{t(`sandbox_usage.description.${target.kind}`)}</CardDescription>
                </div>
                <AiUsagePeriodSelect value={period} onChange={setPeriod} dataTestId={`sandbox-usage-period-${target.kind}`} />
            </CardHeader>
            <CardContent className="flex flex-col gap-4 pt-3">
                {usageQuery.isPending ? (
                    <div className="flex min-h-[96px] items-center justify-center">
                        <Spinner size={24} centerScreen={false} label={t("common.loading")} />
                    </div>
                ) : usageQuery.isError || !sandbox ? (
                    <EmptyState size="sm" description={t("sandbox_usage.errors.load")} />
                ) : isEmpty ? (
                    <p className="text-xs text-foreground-secondary">{t("sandbox_usage.empty")}</p>
                ) : (
                    <div className={cn("flex flex-col gap-4 transition-opacity", usageQuery.isPlaceholderData && "opacity-50")} aria-busy={usageQuery.isPlaceholderData}>
                        <div className="flex flex-wrap gap-4">
                            <StatTile size="sm" className="flex-[1_0_160px]" label={t("sandbox_usage.exec")} value={minutesValue(sandbox.total.execSeconds)} title={t("sandbox_usage.exec_hint")} />
                            <StatTile
                                size="sm"
                                className="flex-[1_0_160px]"
                                label={t("sandbox_usage.lifetime")}
                                value={minutesValue(sandbox.total.lifetimeSeconds)}
                                title={t("sandbox_usage.lifetime_hint")}
                            />
                            <StatTile size="sm" className="flex-[1_0_160px]" label={t("sandbox_usage.commands")} value={sandbox.total.commands.toLocaleString(i18n.language)} />
                        </div>
                        <section className="flex flex-col gap-2" aria-labelledby={`sandbox-usage-chart-${target.kind}`}>
                            <div>
                                <h3 id={`sandbox-usage-chart-${target.kind}`} className="text-sm font-medium">
                                    {t("sandbox_usage.chart.title")}
                                </h3>
                                <p className="text-xs text-foreground-secondary">{t("sandbox_usage.chart.description")}</p>
                            </div>
                            {codedSomething ? (
                                <div className="h-48 w-full" role="img" aria-label={t("sandbox_usage.chart.title")} data-testid={`sandbox-usage-chart-${target.kind}`}>
                                    <ResponsiveContainer width="100%" height="100%">
                                        <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap={2}>
                                            <CartesianGrid vertical={false} stroke="var(--color-divider)" />
                                            <XAxis
                                                dataKey="day"
                                                tickFormatter={day => dayLabel(day, "d MMM")}
                                                tick={{ fill: "var(--color-foreground-secondary)", fontSize: 11 }}
                                                axisLine={{ stroke: "var(--color-border)" }}
                                                tickLine={false}
                                                minTickGap={24}
                                            />
                                            <YAxis
                                                width={36}
                                                allowDecimals={false}
                                                tick={{ fill: "var(--color-foreground-secondary)", fontSize: 11 }}
                                                axisLine={false}
                                                tickLine={false}
                                                tickFormatter={value => Number(value).toLocaleString(i18n.language)}
                                            />
                                            <Tooltip content={renderTooltip} cursor={{ fill: "var(--color-muted)" }} />
                                            <Bar dataKey="minutes" fill="var(--color-primary)" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
                                        </BarChart>
                                    </ResponsiveContainer>
                                </div>
                            ) : (
                                <p className="text-xs text-foreground-secondary">{t("sandbox_usage.chart.empty")}</p>
                            )}
                        </section>
                        {breakdown && breakdown.length > 0 && (
                            <Table>
                                <TableHeader tinted={false}>
                                    <TableRow>
                                        <TableHead>{t(`ai_usage.columns.${target.kind === "organization" ? "project" : "source"}`)}</TableHead>
                                        <TableHead className="text-right" title={t("sandbox_usage.exec_hint")}>
                                            {t("sandbox_usage.exec_minutes")}
                                        </TableHead>
                                        <TableHead className="text-right" title={t("sandbox_usage.lifetime_hint")}>
                                            {t("sandbox_usage.lifetime_minutes")}
                                        </TableHead>
                                        <TableHead className="text-right">{t("sandbox_usage.commands")}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {breakdown.map(row => (
                                        <TableRow key={row.key}>
                                            <TableCell className="font-medium">{row.label}</TableCell>
                                            <TableCell className="text-right tabular-nums">{minutes(row.execSeconds)}</TableCell>
                                            <TableCell className="text-right tabular-nums text-muted-foreground">{minutes(row.lifetimeSeconds)}</TableCell>
                                            <TableCell className="text-right tabular-nums">{row.commands.toLocaleString(i18n.language)}</TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                        <p className="text-xs text-foreground-secondary">
                            {usage?.since ? t("ai_usage.since", { date: format(new Date(usage.since), "PP", { locale: themeStore.getLocale() }) }) : t("ai_usage.since_start")}
                        </p>
                    </div>
                )}
            </CardContent>
        </Card>
    )
}

export default SandboxUsageCard
