import { useQuery } from "@tanstack/react-query"
import { Workflow } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import useDomainsApi from "@/hooks/apiClients/useDomainsApi"
import useProjectStore from "@/store/useProjectStore"
import DomainBuildAndDeployButton from "./DomainBuildAndDeployDialog"

/**
 * Build and deploy of a frontend or a backend, the same as its domain's: there is no release of one of them alone.
 * Always there: without a domain, or before the domains load, it is disabled.
 */
export const ComponentBuildAndDeployButton: React.FC<{ domainId?: string | null }> = ({ domainId }) => {
    const { t } = useTranslation()
    const domainsApi = useDomainsApi()
    const projectId = useProjectStore(state => state.project?._id)
    // The list the domain filter reads too: one request for the whole project
    const domainsQuery = useQuery({ queryKey: ["domains", projectId], queryFn: domainsApi.getAll, enabled: !!projectId && !!domainId })
    const domain = domainsQuery.data?.find(candidate => candidate._id === domainId)

    if (domain) return <DomainBuildAndDeployButton domain={domain} />

    return (
        <Button disabled title={domainId ? undefined : t("domains.release.no_domain")}>
            <Workflow />
            {t("domains.release.action")}
        </Button>
    )
}

export default ComponentBuildAndDeployButton
