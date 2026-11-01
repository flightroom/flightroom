import { useQuery } from "@tanstack/react-query"
import { Workflow } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import useDomainsApi, { type DomainMemberScope } from "@/hooks/apiClients/useDomainsApi"
import useProjectStore from "@/store/useProjectStore"
import DomainBuildAndDeployButton from "./DomainBuildAndDeployDialog"

/**
 * Build and deploy of a frontend or a backend alone: the release of its domain limited to it, its repository built
 * and the domain deployed, the others keeping the version they run. Always there: without a domain, or before the
 * domains load, it is disabled.
 */
export const ComponentBuildAndDeployButton: React.FC<{ domainId?: string | null; member: DomainMemberScope & { name: string } }> = ({ domainId, member }) => {
    const { t } = useTranslation()
    const domainsApi = useDomainsApi()
    const projectId = useProjectStore(state => state.project?._id)
    // The list the domain filter reads too: one request for the whole project
    const domainsQuery = useQuery({ queryKey: ["domains", projectId], queryFn: domainsApi.getAll, enabled: !!projectId && !!domainId })
    const domain = domainsQuery.data?.find(candidate => candidate._id === domainId)

    if (domain) return <DomainBuildAndDeployButton domain={domain} member={member} />

    return (
        <Button disabled title={domainId ? undefined : t("domains.release.no_domain")}>
            <Workflow />
            {t("domains.release.action")}
        </Button>
    )
}

export default ComponentBuildAndDeployButton
