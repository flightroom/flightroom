import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@flightroom/design-system"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Rocket } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import EnvironmentSelector from "@/components/molecules/EnvironmentSelector"
import useDeploymentsApi, { DEPLOY_MUTATION_KEY } from "@/hooks/apiClients/useDeploymentsApi"
import type { Domain } from "@/hooks/apiClients/useDomainsApi"
import { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import { useProjectEnvironmentsQuery } from "@/pages/backends/partials/backendVariables"
import useProjectStore, { useIsProjectViewer } from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"

const NO_ENVIRONMENTS: EnvironmentDTO[] = []

/**
 * Deploys the domain to an environment as it is set now, without building it: only its frontends and backends
 * move, each at the version it has, the one set in the settings of the domain or registered by its CI.
 */
interface DomainDeployButtonProps {
    domain: Domain
    open?: boolean
    onOpenChange?: (open: boolean) => void
    showTrigger?: boolean
}

export const DomainDeployButton: React.FC<DomainDeployButtonProps> = ({ domain, open, onOpenChange, showTrigger = true }) => {
    const { t } = useTranslation()
    const deploymentsApi = useDeploymentsApi()
    const queryClient = useQueryClient()
    const notifications = useToastNotificationStore()
    const isViewer = useIsProjectViewer()
    const storeEnvironmentId = useProjectStore(state => state.environment?._id)
    const [internalOpen, setInternalOpen] = useState(false)
    const dialogOpen = open ?? internalOpen
    const setDialogOpen = onOpenChange ?? setInternalOpen
    const [environment, setEnvironment] = useState<EnvironmentDTO | undefined>()

    // Read here, not from the store: the store has them only once a page under the environments gate was opened
    const environments = useProjectEnvironmentsQuery().data ?? NO_ENVIRONMENTS
    const selected = environments.find(candidate => candidate._id === environment?._id) ?? environments.find(candidate => candidate._id === storeEnvironmentId) ?? environments[0]

    // With GitOps on the deploy commits to the repositories first, and takes a while: the deploy overlay follows it
    const deployMutation = useMutation({
        mutationKey: DEPLOY_MUTATION_KEY,
        mutationFn: (target: EnvironmentDTO) => deploymentsApi.createDeployment([target._id!], domain._id),
        onSuccess: async (_deployment, target) => {
            notifications.showSuccessNotification({ message: t("domains.deploy.success", { domain: domain.name, environment: target.name }) })
            setDialogOpen(false)
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: ["deployments", target._id] }),
                queryClient.invalidateQueries({ queryKey: ["domain-deployments"] }),
                queryClient.invalidateQueries({ queryKey: ["domain-deployments-matrix"] })
            ])
        }
    })

    // A viewer may look, not deploy
    if (isViewer) return null

    const changeOpen = (value: boolean) => {
        if (deployMutation.isPending) return
        setDialogOpen(value)
    }

    return (
        <>
            {showTrigger && (
                <Button variant="secondary" onClick={() => setDialogOpen(true)} disabled={environments.length === 0} dataTestId="domain-deploy">
                    <Rocket />
                    {t("domains.deploy.action")}
                </Button>
            )}
            <Dialog open={dialogOpen} onOpenChange={changeOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("domains.deploy.title", { domain: domain.name })}</DialogTitle>
                        <DialogDescription>{t("domains.deploy.description")}</DialogDescription>
                    </DialogHeader>
                    <div className="mt-2 mb-4">
                        <EnvironmentSelector selectedEnvironment={selected} environments={environments} onEnvironmentChange={setEnvironment} />
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="secondary" onClick={() => changeOpen(false)} disabled={deployMutation.isPending}>
                            {t("common.cancel")}
                        </Button>
                        <Button
                            type="button"
                            onClick={() => selected && deployMutation.mutate(selected)}
                            disabled={!selected?._id || deployMutation.isPending}
                            loading={deployMutation.isPending}
                            loadingLabel={t("deployments.deploying")}
                            dataTestId="domain-deploy-confirm"
                        >
                            <Rocket />
                            {t("domains.deploy.confirm")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    )
}

export default DomainDeployButton
