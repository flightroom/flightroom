import { useQuery } from "@tanstack/react-query"
import { useParams } from "react-router-dom"
import { ApiStatusHandler } from "@/components/organisms"
import useCodeRepositoriesApi from "@/hooks/apiClients/useCodeRepositoriesApi"
import useFrontendsApi from "@/hooks/apiClients/useFrontendsApi"
import useStorageApi from "@/hooks/apiClients/useStorageApi"
import { useProjectEnvironmentsQuery } from "@/pages/backends/partials/backendVariables"
import { AddFrontendForm } from "@/pages/frontends/partials/add-frontend/AddFrontendForm"
import { useVariableMapsQuery } from "@/pages/variable-maps/partials/variableMaps"
import useProjectStore from "@/store/useProjectStore"

const AddNewFrontendPage: React.FC = () => {
    const { id } = useParams<{ id: string }>()
    const isEdit = Boolean(id)
    const frontendsApi = useFrontendsApi()
    const storageApi = useStorageApi()
    const codeRepositoriesApi = useCodeRepositoriesApi()
    const { project } = useProjectStore()

    const storagesQuery = useQuery({
        queryKey: ["storages", project?._id],
        queryFn: () => storageApi.getMultiple(project?._id)
    })

    const repositoriesQuery = useQuery({
        queryKey: ["repositories", project?._id],
        queryFn: () => codeRepositoriesApi.getRepositoriesByProjectId(project?._id!),
        enabled: !!project?._id
    })

    const frontendQuery = useQuery({
        queryKey: ["mfe", id],
        queryFn: () => frontendsApi.getSingle(id),
        enabled: isEdit
    })

    const versionsQuery = useQuery({
        queryKey: ["versions", id],
        queryFn: () => frontendsApi.getVersions(id!),
        enabled: isEdit
    })

    // The endpoint of a DOCKER frontend previews its URL in every environment
    const environmentsQuery = useProjectEnvironmentsQuery()
    const configMapsQuery = useVariableMapsQuery("configMap")
    const secretsQuery = useVariableMapsQuery("secret")

    return (
        <ApiStatusHandler queries={[storagesQuery, repositoriesQuery, versionsQuery, frontendQuery, environmentsQuery, configMapsQuery, secretsQuery]} interceptEmpty={false}>
            <AddFrontendForm
                storages={storagesQuery.data}
                repositories={repositoriesQuery.data}
                frontend={frontendQuery.data}
                versions={versionsQuery.data}
                environments={environmentsQuery.data ?? []}
                configMaps={configMapsQuery.data ?? []}
                secrets={secretsQuery.data ?? []}
            />
        </ApiStatusHandler>
    )
}

export default AddNewFrontendPage
