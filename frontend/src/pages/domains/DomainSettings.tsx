import { Alert, AlertDescription, Spinner } from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { useParams } from "react-router-dom"
import useDomainsApi from "@/hooks/apiClients/useDomainsApi"
import DomainDetailsSection from "./partials/DomainDetailsSection"
import DomainHeader from "./partials/DomainHeader"

/** Details and settings of the domain: what it is. */
const DomainSettings: React.FC = () => {
    const { t } = useTranslation()
    const { id } = useParams<{ id: string }>()
    const domainsApi = useDomainsApi()

    // The same query as the overview: moving between the two tabs reads nothing again
    const domainQuery = useQuery({ queryKey: ["domain", id], queryFn: () => domainsApi.getSingle(id!), enabled: !!id })

    // Not an ApiStatusHandler, as in the overview: it would unmount the form, and what is typed in it, on every background refetch
    if (domainQuery.isPending && domainQuery.isEnabled) {
        return (
            <div className="flex min-h-[200px] items-center justify-center">
                <Spinner size={32} />
            </div>
        )
    }

    if (domainQuery.isLoadingError || !domainQuery.data) {
        return (
            <Alert variant="destructive">
                <AlertDescription>{domainQuery.error instanceof Error ? domainQuery.error.message : t("app.error.generic")}</AlertDescription>
            </Alert>
        )
    }

    return (
        <div className="flex min-h-full flex-col gap-6">
            <DomainHeader domain={domainQuery.data} active="settings" />
            <DomainDetailsSection domain={domainQuery.data} />
        </div>
    )
}

export default DomainSettings
