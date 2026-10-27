import { Alert, AlertDescription, Spinner } from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { useParams } from "react-router-dom"
import AiUsageSummary from "@/components/ai-usage/AiUsageSummary"
import ApplicationLogsSection, { LogsApplication } from "@/components/application-logs/ApplicationLogsSection"
import useBackendsApi from "@/hooks/apiClients/useBackendsApi"
import useDomainDeploymentsApi from "@/hooks/apiClients/useDomainDeploymentsApi"
import useDomainsApi from "@/hooks/apiClients/useDomainsApi"
import useFrontendsApi, { FrontendKind } from "@/hooks/apiClients/useFrontendsApi"
import { useProjectEnvironmentsQuery } from "@/pages/backends/partials/backendVariables"
import useProjectStore from "@/store/useProjectStore"
import DomainDeploymentsSection from "./partials/DomainDeploymentsSection"
import DomainHeader from "./partials/DomainHeader"
import DomainMembersSection from "./partials/DomainMembersSection"
import DomainResourcesSection from "./partials/DomainResourcesSection"

/** What the domain runs and reaches, next to Edit with AI: its frontends and backends, the versions deployed in each environment, the resources of its backends, the AI tokens it spent. */
const DomainOverview: React.FC = () => {
    const { t } = useTranslation()
    const { id } = useParams<{ id: string }>()
    const projectId = useProjectStore(state => state.project?._id)
    const domainsApi = useDomainsApi()
    const domainDeploymentsApi = useDomainDeploymentsApi()
    const frontendsApi = useFrontendsApi()
    const backendsApi = useBackendsApi()

    const domainQuery = useQuery({ queryKey: ["domain", id], queryFn: () => domainsApi.getSingle(id!), enabled: !!id })
    const deploymentsQuery = useQuery({ queryKey: ["domain-deployments", id], queryFn: () => domainDeploymentsApi.getByDomain(id!), enabled: !!id })
    const backendsQuery = useQuery({ queryKey: ["backends", projectId], queryFn: backendsApi.getAll, enabled: !!projectId })
    // Every frontend of the project, not only the domain's: the DOCKER that serves a bundle may sit in another domain
    const frontendsQuery = useQuery({
        queryKey: ["frontends-by-project-id", projectId],
        queryFn: () => frontendsApi.getByProjectId(projectId!),
        enabled: !!projectId
    })

    const environmentsQuery = useProjectEnvironmentsQuery()

    // Not an ApiStatusHandler: it unmounts its children on every background refetch, and with them an open dialog of the header or of the resources.
    const queries = [domainQuery, deploymentsQuery, backendsQuery, frontendsQuery, environmentsQuery]
    if (queries.some(query => query.isPending)) {
        return (
            <div className="flex min-h-[200px] items-center justify-center">
                <Spinner size={32} />
            </div>
        )
    }

    // Only a first load that failed: a background refetch that fails keeps what was loaded.
    const failed = queries.find(query => query.isLoadingError)
    if (failed || !domainQuery.data) {
        return (
            <Alert variant="destructive">
                <AlertDescription>{failed?.error instanceof Error ? failed.error.message : t("app.error.generic")}</AlertDescription>
            </Alert>
        )
    }

    const backends = (backendsQuery.data ?? []).filter(backend => backend.domainId === id && backend._id)
    // What runs in pods: the backends and the Docker frontends of the domain, a static bundle has no logs
    const applications: LogsApplication[] = [...backends, ...(frontendsQuery.data ?? []).filter(frontend => frontend.domainId === id && frontend.kind === FrontendKind.DOCKER)].map(application => ({
        slug: application.slug,
        name: application.name
    }))

    return (
        <div className="flex min-h-full flex-col gap-6">
            <DomainHeader domain={domainQuery.data} active="overview" />
            <DomainMembersSection domain={domainQuery.data} frontends={frontendsQuery.data ?? []} backends={backendsQuery.data ?? []} />
            {deploymentsQuery.data && <DomainDeploymentsSection deployments={deploymentsQuery.data} frontends={frontendsQuery.data ?? []} />}
            <DomainResourcesSection backends={backends} />
            <AiUsageSummary target={{ kind: "domain", id: id! }} />
            {applications.length > 0 && <ApplicationLogsSection applications={applications} environments={environmentsQuery.data ?? []} />}
        </div>
    )
}

export default DomainOverview
