import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import useDomainsApi from "@/hooks/apiClients/useDomainsApi"
import useProjectStore from "@/store/useProjectStore"
import DomainDeployButton from "./DomainDeployDialog"

/** The deploy of a frontend or a backend: there is no deploy of one of them alone, so it deploys its domain. Without a domain, there is no button. */
export const DomainDeployReleaseButton: React.FC<{ domainId?: string | null }> = ({ domainId }) => {
    const { t } = useTranslation()
    const domainsApi = useDomainsApi()
    const projectId = useProjectStore(state => state.project?._id)
    // The list the domain filter reads too: one request for the whole project
    const domainsQuery = useQuery({ queryKey: ["domains", projectId], queryFn: domainsApi.getAll, enabled: !!projectId && !!domainId })
    const domain = domainsQuery.data?.find(candidate => candidate._id === domainId)

    if (!domain) return null

    return <DomainDeployButton domain={domain} label={t("domains.deploy.release_action")} />
}

export default DomainDeployReleaseButton
