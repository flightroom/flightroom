import { EmptyState, SearchInput } from "@flightroom/design-system"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { PackageOpen, RadioTower, RefreshCw, SearchX } from "lucide-react"
import React, { useCallback, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import SinglePageLayout from "@/components/SinglePageLayout"
import useBuildsApi, { BUILD_STATUS_QUERY_KEY, ComponentBuildStatus, ProjectBuildStatus, useBuildStatusStream } from "@/hooks/apiClients/useBuildsApi"
import useProjectStore from "@/store/useProjectStore"
import { cn } from "@/utils/styleUtils"
import BuildStatusTable from "./partials/BuildStatusTable"

/** A component matches when the term appears in its name, slug or linked repository. */
const matchesSearch = (component: ComponentBuildStatus, term: string) => [component.name, component.slug, component.repositoryName].some(value => value?.toLowerCase().includes(term))

export const Builds: React.FC = () => {
    const { t } = useTranslation()
    const projectStore = useProjectStore()
    const { getBuildStatus } = useBuildsApi()
    const queryClient = useQueryClient()
    const [searchTerm, setSearchTerm] = useState("")

    const projectId = projectStore.project?._id

    const buildStatusQuery = useQuery({
        queryKey: [BUILD_STATUS_QUERY_KEY, projectId],
        queryFn: getBuildStatus,
        enabled: Boolean(projectId)
    })

    // The stream owns the data from its first frame onwards: it always carries a full
    // snapshot, so it replaces the query cache rather than triggering a refetch.
    const onSnapshot = useCallback(
        (snapshot: ProjectBuildStatus) => {
            queryClient.setQueryData([BUILD_STATUS_QUERY_KEY, projectId], snapshot)
        },
        [queryClient, projectId]
    )

    const stream = useBuildStatusStream(onSnapshot, Boolean(projectId))

    const data = buildStatusQuery.data
    const totalCount = (data?.microfrontends?.length ?? 0) + (data?.services?.length ?? 0)
    const hasComponents = totalCount > 0

    const term = searchTerm.trim().toLowerCase()
    // Filtering happens here and not in the table, so live snapshots keep the search applied.
    const filteredData = useMemo(() => {
        if (!data || !term) return data
        return {
            ...data,
            microfrontends: (data.microfrontends || []).filter(component => matchesSearch(component, term)),
            services: (data.services || []).filter(component => matchesSearch(component, term))
        }
    }, [data, term])
    const filteredCount = (filteredData?.microfrontends?.length ?? 0) + (filteredData?.services?.length ?? 0)

    return (
        <SinglePageLayout
            title={t("builds.title")}
            description={t("builds.subtitle")}
            lrContainerClassname="items-end"
            left={
                <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-2">
                    {hasComponents && (
                        <SearchInput
                            className="max-w-sm"
                            placeholder={t("builds.search.placeholder")}
                            value={searchTerm}
                            onValueChange={setSearchTerm}
                            onClear={() => setSearchTerm("")}
                            clearLabel={t("builds.search.clear")}
                        />
                    )}
                    <div className="flex items-center gap-4 flex-wrap">
                        {term && (
                            <span className="text-sm text-foreground-secondary" aria-live="polite">
                                {t("builds.search.filtered_count", { count: filteredCount, total: totalCount })}
                            </span>
                        )}
                        <span className="inline-flex items-center gap-2 text-sm text-foreground-secondary">
                            <RadioTower className={cn("size-4", stream.connected ? "text-foreground" : "text-foreground-secondary")} />
                            {stream.connected ? t("builds.live.connected") : t("builds.live.disconnected")}
                        </span>
                        {data?.fetchedAt && (
                            <span className="text-sm text-foreground-secondary">
                                {t("builds.live.last_update", {
                                    moment: new Date(data.fetchedAt).toLocaleTimeString()
                                })}
                            </span>
                        )}
                    </div>
                </div>
            }
            right={
                <Button variant="secondary" onClick={() => buildStatusQuery.refetch()} disabled={buildStatusQuery.isFetching}>
                    <RefreshCw className={cn(buildStatusQuery.isFetching && "animate-spin")} />
                    {t("builds.refresh")}
                </Button>
            }
        >
            <ApiStatusHandler queries={[buildStatusQuery]}>
                {!hasComponents ? (
                    <EmptyState size="default" iconVariant="bare" tone="muted" icon={<PackageOpen />} title={t("builds.empty.title")} description={t("builds.empty.description")} />
                ) : filteredCount === 0 ? (
                    <EmptyState
                        size="default"
                        iconVariant="bare"
                        tone="muted"
                        icon={<SearchX />}
                        title={t("builds.search.no_results_title")}
                        description={t("builds.search.no_results_description", {
                            searchTerm: searchTerm.trim()
                        })}
                        actions={
                            <Button variant="secondary" onClick={() => setSearchTerm("")}>
                                {t("builds.search.clear")}
                            </Button>
                        }
                    />
                ) : (
                    <BuildStatusTable data={filteredData} />
                )}
            </ApiStatusHandler>
        </SinglePageLayout>
    )
}

export default Builds
