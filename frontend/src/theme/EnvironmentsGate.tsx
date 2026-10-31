import { useQuery } from "@tanstack/react-query"
import { useEffect } from "react"
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
        // L'ambiente scelto dall'utente resta, aggiornato; si torna al primo solo se e' stato eliminato
        const current = useProjectStore.getState().environment
        projectStore.setEnvironment(environments.find(environment => environment._id === current?._id) ?? environments[0])
    }

    const onSaveEnvironmentsSucess = (environments: EnvironmentDTO[]) => {
        storeEnvironments(environments)
        onSaveSuccess?.()
    }

    const environmentsQuery = useQuery({
        queryKey: ["environments", projectStore?.project?._id],
        // Niente onSaveSuccess qui: la pagina rifarebbe il fetch della stessa chiave, e con dati in cache react-query annulla quello in corso e ne riparte uno nuovo, all'infinito
        // Lo store si riempie prima che i figli leggano i dati: con il solo effetto sotto, al primo render vedrebbero ancora gli ambienti del progetto di prima
        queryFn: async () => {
            const environments = await projectsApi.getEnvironmentsByProjectId(projectStore.project?._id)
            storeEnvironments(environments)
            return environments
        },
        enabled: !!projectStore.project?._id
    })

    // E segue i dati della chiave anche quando il fetch non passa da questa queryFn: la pagina degli ambienti fa il fetch della stessa chiave con la sua
    // biome-ignore lint/correctness/useExhaustiveDependencies: storeEnvironments cambia a ogni render, conta solo l'arrivo di dati nuovi
    useEffect(() => {
        if (environmentsQuery.data) storeEnvironments(environmentsQuery.data)
    }, [environmentsQuery.data])

    const isThereAtLeastOneEnvironment = projectStore.environments?.length > 0

    return <ApiStatusHandler queries={[environmentsQuery]}>{isThereAtLeastOneEnvironment ? <>{children}</> : <NoEnvironmentPlaceholder onSaveSuccess={onSaveEnvironmentsSucess} />}</ApiStatusHandler>
}

export default EnvironmentsGate
