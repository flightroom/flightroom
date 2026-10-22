import { create } from "zustand"
import { devtools } from "zustand/middleware"
import { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import { Project, RoleInProject } from "@/hooks/apiClients/useProjectApi"

interface ProjectState {
    project?: Project
    projects?: Project[]
    environments?: EnvironmentDTO[]
    environment?: EnvironmentDTO
    /** Cleared with no argument when the organization changes: the project belonged to the previous one. */
    setProject: (project?: Project) => void
    setProjects: (projects: Project[]) => void
    setEnvironments: (environments: EnvironmentDTO[]) => void
    setEnvironment: (environment: EnvironmentDTO) => void
}

const useProjectStore = create<ProjectState>()(
    devtools(
        (set, get) => ({
            setProject: (project?: Project) => {
                set({ project })
            },
            setProjects: (projects: Project[]) => {
                set({ projects })
            },
            setEnvironments: (environments: EnvironmentDTO[]) => {
                set({ environments })
            },
            setEnvironment: (environment: EnvironmentDTO) => {
                set({ environment })
            }
        }),
        {
            name: "project-storage"
        }
    )
)

/** Whether the user only views the current project: the console hides what writes, the server refuses it anyway */
export const useIsProjectViewer = () => useProjectStore(state => state.project?.role === RoleInProject.VIEWER)

export default useProjectStore
