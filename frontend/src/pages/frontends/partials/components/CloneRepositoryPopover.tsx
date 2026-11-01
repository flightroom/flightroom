import { CopyButton, Popover, PopoverContent, PopoverTrigger } from "@flightroom/design-system"
import { Code, ExternalLink, GitBranch, Terminal } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import { ActionTile } from "@/components/EntityCardActions"
import RepositoryLink, { repositoryWebUrl } from "@/components/RepositoryLink"
import { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import { buildGitCloneCommand, buildIntelliJCloneUrl, buildVsCodeCloneUrl } from "@/utils/repositoryCloneUrls"

interface CloneRepositoryPopoverProps {
    /** A frontend or a backend: both keep their repository the same way. */
    frontend: Pick<Frontend, "codeRepository">
    className?: string
    /** Renders the trigger as a compact icon-only button, for tight spots like the flow nodes. */
    iconOnly?: boolean
    /** Renders the trigger as a large square among the actions of a card. */
    tile?: boolean
    /** Renders the trigger as the name of the repository, as a link to it reads; without clone urls, the link itself. */
    link?: boolean
}

interface CloneUrlRowProps {
    label: string
    url: string
}

const CloneUrlRow: React.FC<CloneUrlRowProps> = ({ label, url }) => (
    <div className="flex flex-col gap-1">
        {/* Negli appunti finisce il comando completo, mentre il bottone mostra solo l'url */}
        <CopyButton value={buildGitCloneCommand(url)} label={label} copiedLabel={label} showLabel variant="secondary" size="sm" className="w-full justify-start" title={url} />
        <p className="truncate font-mono text-xs text-foreground-secondary" title={url}>
            {url}
        </p>
    </div>
)

interface IdeCloneButtonProps {
    label: string
    href: string
    icon: React.ReactNode
    variant: "primary" | "secondary"
}

const IdeCloneButton: React.FC<IdeCloneButtonProps> = ({ label, href, icon, variant }) => (
    <Button asChild variant={variant} size="sm" className="w-full justify-start">
        {/* Protocol handler link, so it cannot go through the router-aware `href` prop of Button. */}
        <a href={href}>
            {icon}
            <span className="truncate">{label}</span>
        </a>
    </Button>
)

export const CloneRepositoryPopover: React.FC<CloneRepositoryPopoverProps> = ({ frontend, className, iconOnly = false, tile = false, link = false }) => {
    const { t } = useTranslation("platform")

    const httpsUrl = frontend.codeRepository?.cloneUrlHttps
    const sshUrl = frontend.codeRepository?.cloneUrlSsh
    const ideUrl = httpsUrl || sshUrl
    const webUrl = repositoryWebUrl(frontend.codeRepository)

    if (!frontend.codeRepository?.enabled || (!httpsUrl && !sshUrl)) {
        return link ? <RepositoryLink repository={frontend.codeRepository} /> : null
    }

    return (
        <Popover>
            <PopoverTrigger asChild>
                {tile ? (
                    <ActionTile label={t("frontend.clone.button")} icon={<GitBranch />} className={className} />
                ) : link ? (
                    <button
                        type="button"
                        className={`inline-flex min-w-0 items-center gap-1 underline-offset-4 hover:text-foreground hover:underline ${className ?? ""}`}
                        title={frontend.codeRepository.name}
                    >
                        <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
                        <span className="truncate">{frontend.codeRepository.name || t("frontend.clone.button")}</span>
                    </button>
                ) : (
                    <Button
                        variant="secondary"
                        size={iconOnly ? "icon-sm" : "sm"}
                        className={className}
                        title={iconOnly ? t("frontend.clone.button") : undefined}
                        aria-label={t("frontend.clone.button")}
                    >
                        <GitBranch />
                        {!iconOnly && t("frontend.clone.button")}
                    </Button>
                )}
            </PopoverTrigger>
            <PopoverContent align="end" className="flex w-80 flex-col gap-3">
                <div>
                    <p className="font-semibold">{t("frontend.clone.title")}</p>
                    <p className="text-sm text-foreground-secondary">{t("frontend.clone.description")}</p>
                </div>

                {httpsUrl && <CloneUrlRow label={t("frontend.clone.https")} url={httpsUrl} />}
                {sshUrl && <CloneUrlRow label={t("frontend.clone.ssh")} url={sshUrl} />}

                {ideUrl && (
                    <>
                        <IdeCloneButton label={t("frontend.clone.vscode")} href={buildVsCodeCloneUrl(ideUrl)} icon={<Terminal />} variant="primary" />
                        <IdeCloneButton label={t("frontend.clone.intellij")} href={buildIntelliJCloneUrl(ideUrl)} icon={<Code />} variant="secondary" />
                    </>
                )}
                {/* Its page on the provider: where clicking its name led before the popover */}
                {webUrl && (
                    <Button asChild variant="ghost" size="sm" className="w-full justify-start">
                        <a href={webUrl} target="_blank" rel="noreferrer">
                            <ExternalLink />
                            <span className="truncate">{t("frontend.clone.open_web")}</span>
                        </a>
                    </Button>
                )}
            </PopoverContent>
        </Popover>
    )
}

export default CloneRepositoryPopover
