import useArgoCdStatus from "@/hooks/useArgoCdStatus"
import { useIsProjectViewer } from "@/store/useProjectStore"

/**
 * Whether the project initialized the Argo CD it deploys with: the logs and the variables of a running container are read through it.
 * Never for a viewer, who reads neither.
 */
const useArgoCdInitialized = () => {
    const isViewer = useIsProjectViewer()
    const { initialized } = useArgoCdStatus()

    return !isViewer && initialized
}

export default useArgoCdInitialized
