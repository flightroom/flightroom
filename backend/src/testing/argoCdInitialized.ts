import { beforeEach, vi } from "vitest"
import Project from "../models/ProjectModel"

/**
 * The project has initialized its Argo CD: for the tests of what creates or changes config maps, secrets and resources,
 * or attaches them, refused without it, which would otherwise wait on a MongoDB that is not there.
 */
export const withArgoCdInitialized = () =>
    beforeEach(() => {
        vi.spyOn(Project, "findById").mockResolvedValue({ argoCd: { initializedAt: new Date() } } as never)
    })
