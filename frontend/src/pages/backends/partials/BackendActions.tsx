import type { Backend } from "@/hooks/apiClients/useBackendsApi"
import ComponentBuildAndDeployButton from "@/pages/domains/partials/ComponentBuildAndDeployButton"
import { useIsProjectViewer } from "@/store/useProjectStore"

/** The action of a backend, in its header, as a frontend's: build and deploy of the backend alone, whose menu builds it alone too. */
export const BackendActions: React.FC<{ backend: Backend }> = ({ backend }) => {
    // A viewer may look, not build nor deploy
    if (useIsProjectViewer()) return null
    return <ComponentBuildAndDeployButton domainId={backend.domainId} member={{ kind: "backend", id: backend._id!, name: backend.name }} />
}

export default BackendActions
