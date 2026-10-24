import { Alert, AlertDescription, Spinner } from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { useParams } from "react-router-dom"
import useBackendsApi from "@/hooks/apiClients/useBackendsApi"
import useDomainsApi from "@/hooks/apiClients/useDomainsApi"
import useFrontendsApi from "@/hooks/apiClients/useFrontendsApi"
import useProjectStore from "@/store/useProjectStore"
import DomainDetailsSection from "./partials/DomainDetailsSection"
import DomainHeader from "./partials/DomainHeader"
import DomainVersionsSection from "./partials/DomainVersionsSection"

/** Details and settings of the domain: what it is, and the version of each of its frontends and backends that its deploy ships. */
const DomainSettings: React.FC = () => {
    const { t } = useTranslation()
    const { id } = useParams<{ id: string }>()
    const projectId = useProjectStore(state => state.project?._id)
    const domainsApi = useDomainsApi()
    const frontendsApi = useFrontendsApi()
    const backendsApi = useBackendsApi()

    // The same queries as the overview: moving between the two tabs reads nothing again
    const domainQuery = useQuery({ queryKey: ["domain", id], queryFn: () => domainsApi.getSingle(id!), enabled: !!id })
    const backendsQuery = useQuery({ queryKey: ["backends", projectId], queryFn: backendsApi.getAll, enabled: !!projectId })
    const frontendsQuery = useQuery({
        queryKey: ["frontends-by-project-id", projectId],
        queryFn: () => frontendsApi.getByProjectId(projectId!),
        enabled: !!projectId
    })

    // Not an ApiStatusHandler, as in the overview: it would unmount the forms, and what is typed in them, on every background refetch
    const queries = [domainQuery, backendsQuery, frontendsQuery]
    // A disabled query stays pending: without a project the page would spin for ever
    if (queries.some(query => query.isPending && query.isEnabled)) {
        return (
            <div className="flex min-h-[200px] items-center justify-center">
                <Spinner size={32} />
            </div>
        )
    }

    const failed = queries.find(query => query.isLoadingError)
    if (failed || !domainQuery.data) {
        return (
            <Alert variant="destructive">
                <AlertDescription>{failed?.error instanceof Error ? failed.error.message : t("app.error.generic")}</AlertDescription>
            </Alert>
        )
    }

    const frontends = (frontendsQuery.data ?? []).filter(frontend => frontend.domainId === id && frontend._id)
    const backends = (backendsQuery.data ?? []).filter(backend => backend.domainId === id && backend._id)

    return (
        <div className="flex min-h-full flex-col gap-6">
            <DomainHeader domain={domainQuery.data} active="settings" />
            <DomainDetailsSection domain={domainQuery.data} />
            <DomainVersionsSection frontends={frontends} backends={backends} />
        </div>
    )
}

export default DomainSettings
