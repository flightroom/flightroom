import { ExternalLink } from "lucide-react"
import { useTranslation } from "react-i18next"

/** Where a deployed frontend or service is reached in the environment of the deployment */
export const DeploymentExposedLink: React.FC<{ url: string }> = ({ url }) => {
    const { t } = useTranslation()

    return (
        <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title={url}
            className="inline-flex max-w-full items-center gap-1 text-xs font-mono text-primary-strong underline-offset-4 hover:underline"
        >
            <span className="truncate">{url}</span>
            <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="sr-only">{t("environment.page.opens_new_tab")}</span>
        </a>
    )
}

export default DeploymentExposedLink
