import type { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import ComponentBuildAndDeployButton from "@/pages/domains/partials/ComponentBuildAndDeployButton"
import { useIsProjectViewer } from "@/store/useProjectStore"

/** The action of a frontend, in its header: build and deploy its domain, whose menu builds alone too. */
export const FrontendActions: React.FC<{ frontend: Frontend }> = ({ frontend }) => {
    // A viewer may look, not build nor deploy
    if (useIsProjectViewer()) return null
    return <ComponentBuildAndDeployButton domainId={frontend.domainId} />
}

export default FrontendActions
