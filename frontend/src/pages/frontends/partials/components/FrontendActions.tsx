import type { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import ComponentBuildAndDeployButton from "@/pages/domains/partials/ComponentBuildAndDeployButton"
import { useIsProjectViewer } from "@/store/useProjectStore"

/** The action of a frontend, in its header: build and deploy of the frontend alone, whose menu builds it alone too. */
export const FrontendActions: React.FC<{ frontend: Frontend }> = ({ frontend }) => {
    // A viewer may look, not build nor deploy
    if (useIsProjectViewer()) return null
    return <ComponentBuildAndDeployButton domainId={frontend.domainId} member={{ kind: "frontend", id: frontend._id!, name: frontend.name }} />
}

export default FrontendActions
