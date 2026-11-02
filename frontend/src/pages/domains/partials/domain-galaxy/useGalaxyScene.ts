import { useQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useRef } from "react"
import { useTranslation } from "react-i18next"
import { useWorkingAgentJobs } from "@/components/ai-agents/WorkingAgentsIndicator"
import type { Backend } from "@/hooks/apiClients/useBackendsApi"
import type { Domain } from "@/hooks/apiClients/useDomainsApi"
import type { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import useMaintenanceAgentsApi, { type MaintenanceAgent } from "@/hooks/apiClients/useMaintenanceAgentsApi"
import type { Resource } from "@/hooks/apiClients/useResourcesApi"
import type { VariableMap } from "@/hooks/apiClients/useVariableMapsApi"
import { useVariableMapsQuery } from "@/pages/variable-maps/partials/variableMaps"
import useProjectStore from "@/store/useProjectStore"
import { buildGalaxyMap, placeShips, placeStations } from "./layout"
import type { StarNode } from "./types"

/** The same empty list at every render: a new one would place the stations again */
const NO_AGENTS: MaintenanceAgent[] = []
const NO_MAPS: VariableMap[] = []

interface GalaxySceneInput {
    domains: Domain[]
    frontends: Frontend[]
    backends: Backend[]
    resources: Resource[]
    isBackend: boolean
}

/** Everything on the map: the galaxies and their worlds, the moons, the comets of the config maps and the secrets, the ships of the agents at work and the maintenance stations. */
const useGalaxyScene = ({ domains, frontends, backends, resources, isBackend }: GalaxySceneInput) => {
    const { t } = useTranslation()
    const previousNodesRef = useRef<StarNode[]>([])
    const workingJobs = useWorkingAgentJobs()
    const maintenanceAgentsApi = useMaintenanceAgentsApi()
    const projectId = useProjectStore(state => state.project?._id)
    const { data: maintenanceAgents = NO_AGENTS } = useQuery({
        queryKey: ["maintenance-agents", projectId],
        queryFn: () => maintenanceAgentsApi.getAll(),
        enabled: Boolean(projectId),
        staleTime: 60_000
    })
    const { data: configMaps = NO_MAPS } = useVariableMapsQuery("configMap")
    const { data: secrets = NO_MAPS } = useVariableMapsQuery("secret")

    const map = useMemo(
        () => buildGalaxyMap({ domains, frontends, backends, resources, configMaps, secrets, isBackend, t, previousNodes: previousNodesRef.current }),
        [domains, frontends, backends, resources, configMaps, secrets, isBackend, t]
    )
    const { graphData } = map

    useEffect(() => {
        previousNodesRef.current = graphData.nodes
    }, [graphData])

    const { ships, agents } = useMemo(() => placeShips(workingJobs, graphData.nodes), [workingJobs, graphData])
    const { stations, stationsByWorld } = useMemo(() => placeStations(maintenanceAgents, graphData.nodes), [maintenanceAgents, graphData])

    return { ...map, ships, agents, stations, stationsByWorld }
}

export default useGalaxyScene
