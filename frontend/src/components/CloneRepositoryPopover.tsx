import { CloneRepositoryPopover as DsCloneRepositoryPopover } from "@flightroom/design-system"
import { GitBranch } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import { ActionTile } from "@/components/EntityCardActions"
import RepositoryLink, { repositoryWebUrl } from "@/components/RepositoryLink"
import { Frontend } from "@/hooks/apiClients/useFrontendsApi"

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

export const CloneRepositoryPopover: React.FC<CloneRepositoryPopoverProps> = ({ frontend, className, iconOnly = false, tile = false, link = false }) => {
    const { t } = useTranslation("platform")

    const httpsUrl = frontend.codeRepository?.cloneUrlHttps
    const sshUrl = frontend.codeRepository?.cloneUrlSsh

    if (!frontend.codeRepository?.enabled || (!httpsUrl && !sshUrl)) {
        return link ? <RepositoryLink repository={frontend.codeRepository} /> : null
    }

    return (
        <DsCloneRepositoryPopover
            httpsUrl={httpsUrl}
            sshUrl={sshUrl}
            webUrl={repositoryWebUrl(frontend.codeRepository)}
            labels={{
                title: t("frontend.clone.title"),
                description: t("frontend.clone.description"),
                https: t("frontend.clone.https"),
                ssh: t("frontend.clone.ssh"),
                vscode: t("frontend.clone.vscode"),
                intellij: t("frontend.clone.intellij"),
                openWeb: t("frontend.clone.open_web")
            }}
        >
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
                <Button variant="secondary" size={iconOnly ? "icon-sm" : "sm"} className={className} title={iconOnly ? t("frontend.clone.button") : undefined} aria-label={t("frontend.clone.button")}>
                    <GitBranch />
                    {!iconOnly && t("frontend.clone.button")}
                </Button>
            )}
        </DsCloneRepositoryPopover>
    )
}

export default CloneRepositoryPopover
