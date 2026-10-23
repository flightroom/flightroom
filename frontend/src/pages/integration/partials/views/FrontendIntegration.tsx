import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CodeBlock,
    Select,
    SelectContent,
    SelectControl,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger
} from "@flightroom/design-system"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import { DeploymentDTO } from "@/hooks/apiClients/useDeploymentsApi"
import { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import { FrontendCompiler, FrontendFramework } from "@/hooks/apiClients/useServeApi"
import FrontendSelector from "@/pages/integration/partials/components/FrontendSelector"
import IntegrateFrontendsDialog from "@/pages/integration/partials/components/IntegrateFrontendsDialog"
import { CodeIntegration } from "../index"

const AUTO = "AUTO"

const FRAMEWORK_OPTIONS: { value: FrontendFramework; label: string }[] = [
    { value: "REACT", label: "React" },
    { value: "VUE", label: "Vue" },
    { value: "ANGULAR", label: "Angular" }
]

const COMPILER_OPTIONS: { value: FrontendCompiler; label: string }[] = [
    { value: "VITE", label: "Vite" },
    { value: "WEBPACK", label: "Webpack" },
    { value: "WEBCOMPONENT", label: "Web Component" },
    { value: "SINGLE_SPA", label: "single-spa" },
    { value: "MICRO_LC", label: "micro-lc" }
]

export const FrontendIntegration = ({ deployment }: { deployment: DeploymentDTO }) => {
    const { t } = useTranslation()
    const [activeTab, setActiveTab] = useState("federation")
    const activeDeployment = deployment instanceof Array ? deployment.find(d => d.active) : deployment

    const curlExample = `# Example CURL request to fetch a remote module
  curl -X GET https://${window.location.host}/api/serve/all/${activeDeployment.environmentId}`

    const [selectedFrontend, setSelectedFrontend] = useState<Frontend>(activeDeployment.frontends[0])
    // Undefined means "use the stack stored on the frontend", which is the normal case:
    // these are here for when detection got it wrong, or for reading another stack's instructions
    const [framework, setFramework] = useState<FrontendFramework | undefined>()
    const [compiler, setCompiler] = useState<FrontendCompiler | undefined>()
    // Undefined opens the dialog on the whole project, an id narrows it to one frontend
    const [integrateOnly, setIntegrateOnly] = useState<string | undefined>()
    const [isIntegrateDialogOpen, setIsIntegrateDialogOpen] = useState(false)

    const openIntegrateDialog = (onlyFrontendId?: string) => {
        setIntegrateOnly(onlyFrontendId)
        setIsIntegrateDialogOpen(true)
    }

    return (
        <Card>
            <CardHeader className="border-none">
                <CardTitle as="h2">{t("integration.fe_integration_tab.title")}</CardTitle>
                <p>{t("integration.fe_integration_tab.description")}</p>
            </CardHeader>

            <CardContent>
                <div className="flex gap-2 flex-wrap items-end mb-4">
                    <FrontendSelector frontends={activeDeployment.frontends} selectedFrontend={selectedFrontend} onSelect={setSelectedFrontend} />
                    <Button onClick={() => openIntegrateDialog()}>{t("integration.fe_integration_tab.integrate_all_button")}</Button>
                    <Button variant="secondary" onClick={() => openIntegrateDialog(selectedFrontend?._id)} disabled={!selectedFrontend}>
                        {t("integration.fe_integration_tab.integrate_one_button")}
                    </Button>
                </div>

                <IntegrateFrontendsDialog isOpen={isIntegrateDialogOpen} onOpenChange={setIsIntegrateDialogOpen} onlyFrontendId={integrateOnly} />

                {selectedFrontend ? (
                    <Tabs value={activeTab} onValueChange={setActiveTab} tabsListPosition="fullWidth">
                        <TabsList>
                            <TabsTrigger className="flex-[1_1_120px]" value="federation">
                                {t("integration.fe_integration_tab.federation_tab")}
                            </TabsTrigger>
                            <TabsTrigger className="flex-[1_1_120px]" value="curl">
                                {t("integration.fe_integration_tab.curl.title")}
                            </TabsTrigger>
                        </TabsList>

                        <TabsContent value="federation">
                            <div className="flex gap-2 flex-wrap items-end mb-4">
                                <SelectControl label={t("integration.fe_integration_tab.framework_label")} className="w-full max-w-60">
                                    <Select value={framework ?? AUTO} onValueChange={value => setFramework(value === AUTO ? undefined : (value as FrontendFramework))}>
                                        <SelectTrigger className="w-full">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value={AUTO}>{t("integration.fe_integration_tab.stack_auto")}</SelectItem>
                                            {FRAMEWORK_OPTIONS.map(option => (
                                                <SelectItem key={option.value} value={option.value}>
                                                    {option.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </SelectControl>

                                <SelectControl label={t("integration.fe_integration_tab.compiler_label")} className="w-full max-w-60">
                                    <Select value={compiler ?? AUTO} onValueChange={value => setCompiler(value === AUTO ? undefined : (value as FrontendCompiler))}>
                                        <SelectTrigger className="w-full">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value={AUTO}>{t("integration.fe_integration_tab.stack_auto")}</SelectItem>
                                            {COMPILER_OPTIONS.map(option => (
                                                <SelectItem key={option.value} value={option.value}>
                                                    {option.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </SelectControl>
                            </div>

                            <CodeIntegration frontendId={selectedFrontend._id} deploymentId={activeDeployment._id} framework={framework} compiler={compiler} />
                        </TabsContent>

                        <TabsContent value="curl">
                            <h3 className="text-lg font-semibold">{t("integration.fe_integration_tab.curl.title")}</h3>
                            <p className="mb-4">{t("integration.fe_integration_tab.curl.description")}</p>
                            <CodeBlock code={curlExample} copyable copyLabel={t("common.copy")} copiedLabel={t("common.copied")} wrapperClassName="mb-4" />
                            <p className="mb-4">{t("integration.fe_integration_tab.curl.step2")}</p>
                            <div className="border-2 border-border rounded-md overflow-hidden">
                                <iframe src={`https://${window.location.host}/api/serve/all/${activeDeployment.environmentId}`} className="w-full h-[500px] border-0" title="API Response Preview" />
                            </div>
                        </TabsContent>
                    </Tabs>
                ) : (
                    <p>{t("integration.frontend_select_placeholder")}</p>
                )}
            </CardContent>
        </Card>
    )
}

export default FrontendIntegration
