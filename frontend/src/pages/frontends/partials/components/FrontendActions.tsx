import { Hammer } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import type { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import DomainDeployReleaseButton from "@/pages/domains/partials/DomainDeployReleaseButton"
import { useIsProjectViewer } from "@/store/useProjectStore"
import { BuildDialog } from "./BuildDialog"

/** The two actions of a frontend, in its header: deploy the release, and build a new one from its repository. */
export const FrontendActions: React.FC<{ frontend: Frontend }> = ({ frontend }) => {
    const { t } = useTranslation()
    const isViewer = useIsProjectViewer()
    const [buildOpen, setBuildOpen] = useState(false)

    // A viewer may look, not build nor deploy
    if (isViewer) return null
    const canBuild = Boolean(frontend.codeRepository?.enabled)

    return (
        <>
            <DomainDeployReleaseButton domainId={frontend.domainId} />
            {canBuild && (
                <>
                    <Button variant="secondary" onClick={() => setBuildOpen(true)}>
                        <Hammer />
                        {t("frontend.card.build")}
                    </Button>
                    <BuildDialog open={buildOpen} onOpenChange={setBuildOpen} frontendId={frontend._id!} frontendName={frontend.name} />
                </>
            )}
        </>
    )
}

export default FrontendActions
