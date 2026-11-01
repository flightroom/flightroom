import { Tabs, TabsContent, TabsList, TabsTrigger } from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { Monitor, Variable } from "lucide-react"
import React, { useState } from "react"
import { useTranslation } from "react-i18next"
import EnvironmentSelector from "@/components/molecules/EnvironmentSelector"
import { ApiStatusHandler } from "@/components/organisms"
import SinglePageLayout from "@/components/SinglePageLayout"
import useDeploymentsApi from "@/hooks/apiClients/useDeploymentsApi"
import DeploymentGate from "@/pages/integration/partials/DeploymentGate"
import useProjectStore from "@/store/useProjectStore"
import EnvironmentsGate from "@/theme/EnvironmentsGate"
import { EnvironmentVariablesIntegration, FrontendIntegration } from "./partials"

export const Integration: React.FC = () => {
    const { t } = useTranslation()
    const projectStore = useProjectStore()
    const deploymentApi = useDeploymentsApi()
    const isThereAtLeastOneEnvironment = projectStore.environments?.length > 0
    const [activeSection, setActiveSection] = useState("frontend")

    const deploymentQuery = useQuery({
        queryKey: ["deployment", projectStore.environment?._id],
        queryFn: () => deploymentApi.getLastDeployment(projectStore.environment?._id),
        enabled: !!projectStore.environment?._id
    })

    return (
        <SinglePageLayout
            title={t("integration.title")}
            description={t("integration.subtitle")}
            left={
                isThereAtLeastOneEnvironment && (
                    <EnvironmentSelector selectedEnvironment={projectStore.environment} environments={projectStore.environments} onEnvironmentChange={projectStore.setEnvironment} />
                )
            }
        >
            <EnvironmentsGate>
                <DeploymentGate environmentId={projectStore.environment?._id}>
                    <ApiStatusHandler queries={[deploymentQuery]}>
                        {!deploymentQuery.data ? (
                            <p>{t("deployments.no_deployments")}</p>
                        ) : (
                            <Tabs value={activeSection} onValueChange={setActiveSection}>
                                <TabsList>
                                    <TabsTrigger value="frontend">
                                        <Monitor />
                                        {t("integration.fe_integration_tab.title")}
                                    </TabsTrigger>
                                    <TabsTrigger value="env-vars">
                                        <Variable />
                                        {t("integration.env_vars_integration_tab.title")}
                                    </TabsTrigger>
                                </TabsList>

                                <TabsContent value="frontend">
                                    <FrontendIntegration deployment={deploymentQuery.data} />
                                </TabsContent>

                                <TabsContent value="env-vars">
                                    <EnvironmentVariablesIntegration projectId={projectStore.project?._id} />
                                </TabsContent>
                            </Tabs>
                        )}
                    </ApiStatusHandler>
                </DeploymentGate>
            </EnvironmentsGate>
        </SinglePageLayout>
    )
}

export default Integration
