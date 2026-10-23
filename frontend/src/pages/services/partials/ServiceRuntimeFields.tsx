import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@flightroom/design-system"
import { useFormContext } from "react-hook-form"
import { useTranslation } from "react-i18next"
import TextField from "@/components/input/TextField.rhf"
import useProjectStore from "@/store/useProjectStore"

/** The port, the probes, the docs paths and the image repository of a container: a service's, or a frontend's served by its own. */
export const ServiceRuntimeFields: React.FC = () => {
    const { t } = useTranslation()
    const { watch } = useFormContext()
    const containerRegistry = useProjectStore(state => state.project?.containerRegistry)

    // Left empty, the deploy takes the image from the registry of the project: say which one, or that a version would not be deployed
    const hasImage = Boolean(watch("image.repository")?.trim())
    const hasVersion = Boolean(watch("version")?.trim())
    const imageHint = hasImage
        ? t("services.image_repository_hint")
        : containerRegistry
          ? t("services.image_repository_hint_registry", { image: `${containerRegistry}/${watch("slug") || "<slug>"}` })
          : hasVersion
            ? t("services.image_repository_missing")
            : t("services.image_repository_hint")

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("services.runtime_settings")}</CardTitle>
                <CardDescription>{t("services.runtime_settings_description")}</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-x-4 gap-y-2 pt-3 md:grid-cols-2">
                <TextField name="port" type="number" label={t("services.port")} required />
                <TextField name="image.repository" label={t("services.image_repository")} placeholder="ghcr.io/acme/orders-api" description={imageHint} />
                <TextField name="livenessPath" label={t("services.liveness_path")} placeholder="/health/live" description={t("services.liveness_path_hint")} required />
                <TextField name="readinessPath" label={t("services.readiness_path")} placeholder="/health/ready" description={t("services.readiness_path_hint")} required />
                <TextField name="docsPath" label={t("services.docs_path")} placeholder="/docs" description={t("services.docs_path_hint")} />
                <TextField name="openApiPath" label={t("services.openapi_path")} placeholder="/openapi.json" description={t("services.openapi_path_hint")} />
            </CardContent>
        </Card>
    )
}

export default ServiceRuntimeFields
