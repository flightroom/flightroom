import { useQueryClient } from "@tanstack/react-query"
import { Hammer } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import type { Backend } from "@/hooks/apiClients/useBackendsApi"
import DomainDeployReleaseButton from "@/pages/domains/partials/DomainDeployReleaseButton"
import { useIsProjectViewer } from "@/store/useProjectStore"
import BackendBuildDialog from "./BackendBuildDialog"

/** The two actions of a backend, in its header, as a frontend's: deploy the release, and build a new one from its repository. */
export const BackendActions: React.FC<{ backend: Backend }> = ({ backend }) => {
    const { t } = useTranslation()
    const isViewer = useIsProjectViewer()
    const queryClient = useQueryClient()
    const [buildOpen, setBuildOpen] = useState(false)

    // A viewer may look, not build nor deploy
    if (isViewer) return null
    const canBuild = Boolean(backend.codeRepository?.enabled)

    return (
        <>
            <DomainDeployReleaseButton domainId={backend.domainId} />
            {canBuild && (
                <>
                    <Button variant="secondary" onClick={() => setBuildOpen(true)}>
                        <Hammer />
                        {t("backends.build.button")}
                    </Button>
                    <BackendBuildDialog
                        open={buildOpen}
                        onOpenChange={setBuildOpen}
                        backend={backend}
                        onBuilt={() => {
                            queryClient.invalidateQueries({ queryKey: ["backend-versions", backend._id] })
                            queryClient.invalidateQueries({ queryKey: ["backend", backend._id] })
                        }}
                    />
                </>
            )}
        </>
    )
}

export default BackendActions
