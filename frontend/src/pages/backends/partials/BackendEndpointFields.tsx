import { Card, CardContent, CardDescription, CardHeader, CardTitle, SwitchField as Switch } from "@flightroom/design-system"
import { ExternalLink } from "lucide-react"
import { useWatch } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/atoms"
import TextField from "@/components/input/TextField.rhf"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import useProjectStore from "@/store/useProjectStore"
import { exposedOrigin } from "./backendVariables"

const WATCHED_FIELDS = ["exposed", "exposurePath"] as const

interface BackendEndpointFieldsProps {
    environments: EnvironmentDTO[]
    placeholder?: string
}

/** Whether a container is exposed, and at which path: the same on the host of every environment, previewed per environment. */
export const BackendEndpointFields: React.FC<BackendEndpointFieldsProps> = ({ environments, placeholder = "/api/orders" }) => {
    const { t } = useTranslation()
    const exposure = useProjectStore(state => state.project?.exposure)
    // useWatch and not watch: watch re-renders the whole form at each keystroke in these fields
    const [watchedExposed, exposurePath] = useWatch({ name: WATCHED_FIELDS }) as [boolean | undefined, string | undefined]
    const exposed = Boolean(watchedExposed)
    const path = exposurePath?.trim() ?? ""

    return (
        <Card>
            <CardHeader className={!exposed ? "border-b-0 pb-0" : ""}>
                <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
                    <div>
                        <CardTitle className="mb-0">{t("backends.urls.title")}</CardTitle>
                        <CardDescription>{t("backends.urls.description")}</CardDescription>
                    </div>
                    <Switch name="exposed" label={t("backends.urls.expose")} />
                </div>
            </CardHeader>

            {exposed && (
                <CardContent className="flex flex-col gap-3 pt-3">
                    <TextField name="exposurePath" label={t("backends.exposure_path")} placeholder={placeholder} description={t("backends.exposure_path_hint")} autoComplete="off" required />
                    {!exposure?.domain ? (
                        <p className="text-sm text-foreground-secondary">{t("backends.urls.no_domain")}</p>
                    ) : environments.length === 0 ? (
                        <p className="text-sm text-foreground-secondary">{t("backends.urls.no_environments")}</p>
                    ) : (
                        <div>
                            <h3 className="mb-2 text-sm font-semibold">{t("backends.urls.preview")}</h3>
                            <ul className="flex flex-col gap-2">
                                {environments.map(environment => {
                                    const url = `${exposedOrigin(exposure, environment)}${path}`
                                    return (
                                        <li key={environment._id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                                            <Badge variant="outline">{environment.name}</Badge>
                                            <a
                                                href={url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="inline-flex min-w-0 items-center gap-1 break-all font-mono text-primary-strong underline-offset-4 hover:underline"
                                            >
                                                {url}
                                                <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
                                                <span className="sr-only">{t("environment.page.opens_new_tab")}</span>
                                            </a>
                                        </li>
                                    )
                                })}
                            </ul>
                        </div>
                    )}
                </CardContent>
            )}
        </Card>
    )
}

export default BackendEndpointFields
