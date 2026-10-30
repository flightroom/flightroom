import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@flightroom/design-system"
import { useWatch } from "react-hook-form"
import { useTranslation } from "react-i18next"
import TextField from "@/components/input/TextField.rhf"
import useProjectStore from "@/store/useProjectStore"
import ContainerResourceFields from "./ContainerResourceFields"

const WATCHED_FIELDS = ["image.repository", "version", "slug"] as const

/** The port, the probes, the docs paths, the image repository, the CPU and the memory of a container: a backend's, or a frontend's served by its own. */
export const BackendRuntimeFields: React.FC = () => {
    const { t } = useTranslation()
    // useWatch and not watch: watch re-renders the whole form at each keystroke in these fields
    const [repository, version, slug] = useWatch({ name: WATCHED_FIELDS }) as (string | undefined)[]
    const containerRegistry = useProjectStore(state => state.project?.containerRegistry)

    // Left empty, the deploy takes the image from the registry of the project: say which one, or that a version would not be deployed
    // A bare name, with no "/", is an image of that registry too
    const image = repository?.trim()
    const hasVersion = Boolean(version?.trim())
    const imageHint = image?.includes("/")
        ? t("backends.image_repository_hint")
        : containerRegistry
          ? t(image ? "backends.image_repository_hint_name" : "backends.image_repository_hint_registry", { image: `${containerRegistry}/${image || slug || "<slug>"}` })
          : !image && hasVersion
            ? t("backends.image_repository_missing")
            : t("backends.image_repository_hint")

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("backends.runtime_settings")}</CardTitle>
                <CardDescription>{t("backends.runtime_settings_description")}</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-x-4 gap-y-2 pt-3 md:grid-cols-2">
                <TextField name="port" type="number" label={t("backends.port")} description={t("backends.port_hint")} required />
                <TextField name="image.repository" label={t("backends.image_repository")} placeholder="ghcr.io/acme/orders-api" description={imageHint} />
                <TextField name="livenessPath" label={t("backends.liveness_path")} placeholder="/health/live" description={t("backends.liveness_path_hint")} required />
                <TextField name="readinessPath" label={t("backends.readiness_path")} placeholder="/health/ready" description={t("backends.readiness_path_hint")} required />
                <TextField name="docsPath" label={t("backends.docs_path")} placeholder="/docs" description={t("backends.docs_path_hint")} />
                <TextField name="openApiPath" label={t("backends.openapi_path")} placeholder="/openapi.json" description={t("backends.openapi_path_hint")} />
                <ContainerResourceFields />
            </CardContent>
        </Card>
    )
}

export default BackendRuntimeFields
