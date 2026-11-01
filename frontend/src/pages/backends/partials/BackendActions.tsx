import type { Backend } from "@/hooks/apiClients/useBackendsApi"
import ComponentBuildAndDeployButton from "@/pages/domains/partials/ComponentBuildAndDeployButton"
import { useIsProjectViewer } from "@/store/useProjectStore"

/** The action of a backend, in its header, as a frontend's: build and deploy its domain, whose menu builds alone too. */
export const BackendActions: React.FC<{ backend: Backend }> = ({ backend }) => {
    // A viewer may look, not build nor deploy
    if (useIsProjectViewer()) return null
    return <ComponentBuildAndDeployButton domainId={backend.domainId} />
}

export default BackendActions
