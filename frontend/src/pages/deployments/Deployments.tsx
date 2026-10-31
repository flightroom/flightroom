import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ArrowUpRight, Layers, Rocket } from "lucide-react"
import React, { useState } from "react"
import { useTranslation } from "react-i18next"
import AskAssistantButton from "@/components/assistant/AskAssistantButton"
import { Button } from "@/components/atoms"
import SinglePageLayout from "@/components/SinglePageLayout"
import useDeploymentsApi, { DEPLOY_MUTATION_KEY } from "@/hooks/apiClients/useDeploymentsApi"
import useProjectStore, { useIsProjectViewer } from "@/store/useProjectStore"
import EnvironmentsGate from "@/theme/EnvironmentsGate"
import EnvironmentSelector from "../../components/molecules/EnvironmentSelector"
import DeploymentList from "./partials/DeploymentList"
import PromoteVersionsDialog from "./partials/PromoteVersionsDialog"
import ScaleReplicasDialog from "./partials/ScaleReplicasDialog"

export const Deployments: React.FC = () => {
    const { t } = useTranslation()
    const projectStore = useProjectStore()
    const deploymentsApi = useDeploymentsApi()
    const queryClient = useQueryClient()
    const isViewer = useIsProjectViewer()
    const [promoting, setPromoting] = useState(false)
    const [scaling, setScaling] = useState(false)

    // The page follows the deploy, to the environment a dialog saved to
    const deployTo = (environmentId: string) => {
        const target = projectStore.environments.find(environment => environment._id === environmentId)
        if (target) projectStore.setEnvironment(target)
        deployMutation.mutate(environmentId)
    }

    const isThereAtLeastOneEnvironment = projectStore.environments?.length > 0

    // With GitOps on the deploy commits to the repositories first, and takes a while
    const deployMutation = useMutation({
        mutationKey: DEPLOY_MUTATION_KEY,
        // The overlay follows the containers until they run what was committed
        meta: { followRollout: true },
        mutationFn: (environmentId: string) => deploymentsApi.createDeployment([environmentId]),
        onSuccess: (_deployment, environmentId) => queryClient.invalidateQueries({ queryKey: ["deployments", environmentId] })
    })

    return (
        <SinglePageLayout
            title={t("deployments.title")}
            description={t("deployments.subtitle")}
            left={
                <div className="w-full flex items-end gap-y-2 gap-x-4 flex-wrap">
                    {isThereAtLeastOneEnvironment && (
                        <>
                            <EnvironmentSelector selectedEnvironment={projectStore.environment} environments={projectStore.environments} onEnvironmentChange={projectStore.setEnvironment} />
                            <Button
                                className="min-w-32"
                                onClick={() => deployMutation.mutate(projectStore.environment?._id)}
                                disabled={!projectStore.environment?._id}
                                loading={deployMutation.isPending}
                                loadingLabel={t("deployments.deploying")}
                            >
                                <Rocket />
                                {t("deployments.deploy_button")}
                            </Button>
                            {/* A viewer may look, not promote; with one environment there is nowhere to promote from */}
                            {!isViewer && projectStore.environments.length > 1 && (
                                <Button variant="secondary" onClick={() => setPromoting(true)} dataTestId="promote-versions">
                                    <ArrowUpRight />
                                    {t("deployments.promotion.action")}
                                </Button>
                            )}
                            {!isViewer && (
                                <Button variant="secondary" onClick={() => setScaling(true)} dataTestId="scale-replicas">
                                    <Layers />
                                    {t("deployments.replicas.action")}
                                </Button>
                            )}
                            {projectStore.environment?._id && (
                                <AskAssistantButton
                                    label={t("assistant.actions.analyze_deployments")}
                                    question={t("assistant.questions.analyze_deployments", { environment: projectStore.environment.name, environmentId: projectStore.environment._id })}
                                    dataTestId="assistant-analyze-deployments"
                                />
                            )}
                        </>
                    )}
                </div>
            }
            lrContainerClassname="items-end"
        >
            {isThereAtLeastOneEnvironment && (
                <>
                    <PromoteVersionsDialog open={promoting} onOpenChange={setPromoting} environments={projectStore.environments} defaultTarget={projectStore.environment} onDeploy={deployTo} />
                    <ScaleReplicasDialog open={scaling} onOpenChange={setScaling} environments={projectStore.environments} defaultEnvironment={projectStore.environment} onDeploy={deployTo} />
                </>
            )}
            <EnvironmentsGate>
                <DeploymentList environmentId={projectStore.environment?._id} />
            </EnvironmentsGate>
        </SinglePageLayout>
    )
}

export default Deployments
