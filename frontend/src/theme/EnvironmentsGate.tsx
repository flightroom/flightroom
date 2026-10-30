import { useQuery } from "@tanstack/react-query"
import { ApiStatusHandler } from "@/components/organisms"
import { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import useProjectApi from "@/hooks/apiClients/useProjectApi"
import NoEnvironmentPlaceholder from "@/pages/environments/partials/NoEnvironmentPlaceholder"
import useProjectStore from "@/store/useProjectStore"

interface EnvironmentsGateProps extends React.PropsWithChildren {
    onSaveSuccess?: () => Promise<void> | void
}

const EnvironmentsGate: React.FC<EnvironmentsGateProps> = ({ children, onSaveSuccess }) => {
    const projectStore = useProjectStore()
    const projectsApi = useProjectApi()

    const storeEnvironments = (environments: EnvironmentDTO[]) => {
        projectStore.setEnvironments(environments)
        projectStore.setEnvironment(environments[0])
    }

    const onSaveEnvironmentsSucess = (environments: EnvironmentDTO[]) => {
        storeEnvironments(environments)
        onSaveSuccess?.()
    }

    const environmentsQuery = useQuery({
        queryKey: ["environments", projectStore?.project?._id],
        // Niente onSaveSuccess qui: la pagina rifarebbe il fetch della stessa chiave, e con dati in cache react-query annulla quello in corso e ne riparte uno nuovo, all'infinito
        queryFn: async () => {
            const environments = await projectsApi.getEnvironmentsByProjectId(projectStore.project?._id)
            storeEnvironments(environments)
            return environments
        },
        enabled: !!projectStore.project?._id
    })

    const isThereAtLeastOneEnvironment = projectStore.environments?.length > 0

    return <ApiStatusHandler queries={[environmentsQuery]}>{isThereAtLeastOneEnvironment ? <>{children}</> : <NoEnvironmentPlaceholder onSaveSuccess={onSaveEnvironmentsSucess} />}</ApiStatusHandler>
}

export default EnvironmentsGate
