import { beforeEach, vi } from "vitest"
import MaintenanceAgent from "../models/MaintenanceAgentModel"

/**
 * The project has no maintenance agent: for the tests of what reads them besides the backends and the frontends
 * (the deploy, the resources, the maps), which would otherwise wait on a MongoDB that is not there.
 */
export const withNoMaintenanceAgents = () =>
    beforeEach(() => {
        vi.spyOn(MaintenanceAgent, "find").mockResolvedValue([] as never)
        vi.spyOn(MaintenanceAgent, "exists").mockResolvedValue(null as never)
        vi.spyOn(MaintenanceAgent, "findOne").mockResolvedValue(null as never)
        vi.spyOn(MaintenanceAgent, "updateMany").mockResolvedValue({ matchedCount: 0, modifiedCount: 0 } as never)
    })
