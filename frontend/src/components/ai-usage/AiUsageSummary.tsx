import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    EmptyState,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Spinner,
    StatTile,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow
} from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { format } from "date-fns"
import { CalendarRange, Coins } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import useAiUsageApi, {
    AI_USAGE_PERIODS,
    AI_USAGE_QUERY_KEY,
    AiUsagePeriod,
    AiUsageSource,
    AiUsageTarget,
    AiUsageTotals,
    OrganizationAiUsageSummary,
    ProjectAiUsageSummary
} from "@/hooks/apiClients/useAiUsageApi"
import useThemeStore from "@/store/useThemeStore"
import { cn } from "@/utils/styleUtils"

const SOURCES: AiUsageSource[] = ["agent", "assistant"]

interface AiUsageSummaryProps {
    target: AiUsageTarget
}

/** One line of the breakdown: what spent the tokens, then the three figures of the tiles. */
interface BreakdownRow extends AiUsageTotals {
    key: string
    label: string
}

/**
 * The AI tokens spent over a period on what the page shows: three figures, the cached part of the input apart as
 * it is far cheaper. The project adds the split between Edit with AI and the assistant, the organization the
 * split by project. Counting started when the ledger shipped: nothing before it is shown.
 */
const AiUsageSummary: React.FC<AiUsageSummaryProps> = ({ target }) => {
    const { t, i18n } = useTranslation()
    const themeStore = useThemeStore()
    const aiUsageApi = useAiUsageApi()
    const [period, setPeriod] = useState<AiUsagePeriod>("30d")

    const usageQuery = useQuery({
        queryKey: [AI_USAGE_QUERY_KEY, target.kind, target.id, period],
        queryFn: () => aiUsageApi.get(target, period),
        // The figures of the previous period stay, dimmed, while the next ones load: the card does not jump. Never
        // those of another domain, repository or project, which the route reuses this card for.
        placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === target.kind && previousQuery?.queryKey[2] === target.id ? previous : undefined)
    })

    const formatted = (value: number) => value.toLocaleString(i18n.language)
    const usage = usageQuery.data

    const breakdown: BreakdownRow[] | undefined =
        usage && "byProject" in usage
            ? (usage as OrganizationAiUsageSummary).byProject.map(project => ({ key: project.projectId, label: project.name ?? t("ai_usage.deleted_project"), ...project }))
            : usage && "bySource" in usage
              ? SOURCES.map(source => ({ key: source, label: t(`ai_usage.sources.${source}`), ...(usage as ProjectAiUsageSummary).bySource[source] }))
              : undefined
    const isEmpty = usage ? usage.total.inputTokens + usage.total.outputTokens === 0 : false

    return (
        <Card data-testid={`ai-usage-${target.kind}`}>
            <CardHeader className="flex-row items-start justify-between gap-3">
                <div className="min-w-0">
                    <CardTitle className="mb-0 flex items-center gap-2">
                        <Coins className="size-5" aria-hidden="true" />
                        {t("ai_usage.title")}
                    </CardTitle>
                    <CardDescription>{t(`ai_usage.description.${target.kind}`)}</CardDescription>
                </div>
                <Select layoutSize="sm" value={period} onValueChange={value => setPeriod(value as AiUsagePeriod)}>
                    <SelectTrigger aria-label={t("ai_usage.period.label")} className="w-auto shrink-0" dataTestId={`ai-usage-period-${target.kind}`}>
                        <CalendarRange aria-hidden="true" />
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {AI_USAGE_PERIODS.map(value => (
                            <SelectItem key={value} value={value}>
                                {t(`ai_usage.period.${value}`)}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 pt-3">
                {usageQuery.isPending ? (
                    <div className="flex min-h-[96px] items-center justify-center">
                        <Spinner size={24} centerScreen={false} label={t("common.loading")} />
                    </div>
                ) : usageQuery.isError || !usage ? (
                    <EmptyState size="sm" description={t("ai_usage.errors.load")} />
                ) : (
                    <div className={cn("flex flex-col gap-4 transition-opacity", usageQuery.isPlaceholderData && "opacity-50")} aria-busy={usageQuery.isPlaceholderData}>
                        <div className="flex flex-wrap gap-4">
                            <StatTile size="sm" className="flex-[1_0_160px]" label={t("ai_usage.input")} value={formatted(usage.total.inputTokens)} title={t("ai_usage.input_hint")} />
                            <StatTile size="sm" className="flex-[1_0_160px]" label={t("ai_usage.cached")} value={formatted(usage.total.cachedInputTokens)} title={t("ai_usage.cached_hint")} />
                            <StatTile size="sm" className="flex-[1_0_160px]" label={t("ai_usage.output")} value={formatted(usage.total.outputTokens)} />
                        </div>
                        {breakdown && breakdown.length > 0 && !isEmpty && (
                            <Table>
                                <TableHeader tinted={false}>
                                    <TableRow>
                                        <TableHead>{t(`ai_usage.columns.${target.kind === "organization" ? "project" : "source"}`)}</TableHead>
                                        <TableHead className="text-right">{t("ai_usage.input")}</TableHead>
                                        <TableHead className="text-right">{t("ai_usage.cached")}</TableHead>
                                        <TableHead className="text-right">{t("ai_usage.output")}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {breakdown.map(row => (
                                        <TableRow key={row.key}>
                                            <TableCell className="font-medium">{row.label}</TableCell>
                                            <TableCell className="text-right tabular-nums">{formatted(row.inputTokens)}</TableCell>
                                            <TableCell className="text-right tabular-nums text-muted-foreground">{formatted(row.cachedInputTokens)}</TableCell>
                                            <TableCell className="text-right tabular-nums">{formatted(row.outputTokens)}</TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                        <p className="text-xs text-foreground-secondary">
                            {isEmpty
                                ? t("ai_usage.empty")
                                : usage.since
                                  ? t("ai_usage.since", { date: format(new Date(usage.since), "PP", { locale: themeStore.getLocale() }) })
                                  : t("ai_usage.since_start")}
                        </p>
                    </div>
                )}
            </CardContent>
        </Card>
    )
}

export default AiUsageSummary
