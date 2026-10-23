import {
    Boxes,
    FileText,
    Hammer as HammerIcon,
    KeyRound,
    Layers,
    LayoutDashboard,
    Link as LinkIcon,
    Package as PackageIcon,
    Rocket as RocketIcon,
    Server,
    Ship,
    SlidersHorizontal,
    Sparkles,
    Wrench
} from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useLocation } from "react-router-dom"
import AssistantPanel, { ASSISTANT_PAGE_PATH } from "@/components/assistant/AssistantPanel"
import useProjectAiModels from "@/components/assistant/useProjectAiModels"
import DeployOverlay from "@/components/deploy-overlay/DeployOverlay"
import { Sidebar, type SidebarNavSection } from "@/components/ui/Sidebar/Sidebar"
import { cn } from "@/utils/styleUtils"
import Header from "./Header"

interface MainLayoutProps {
    children: React.ReactNode
}

const MainLayout: React.FC<MainLayoutProps> = ({ children }) => {
    const { t } = useTranslation()
    const location = useLocation()
    const assistantEnabled = useProjectAiModels().enabled
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)
    // La pagina dell'agente e' gia' la conversazione: il pannello laterale ne sarebbe un doppione.
    const isAssistantPage = location.pathname === ASSISTANT_PAGE_PATH

    const toggleSidebar = () => {
        setIsSidebarCollapsed(!isSidebarCollapsed)
    }

    // Solo voci di progetto: il livello organizzazione vive nell'header, dal suo menu, e le pagine
    // che valgono per tutto il progetto (impostazioni) nel menu in alto. Le variabili d'ambiente
    // valgono solo per i frontend, quindi stanno nella loro sezione. L'agente apre la console
    // ed e' la prima voce, senza titolo di sezione.
    const mainNavSections: SidebarNavSection[] = [
        ...(assistantEnabled ? [{ items: [{ name: t("assistant.page_title"), path: ASSISTANT_PAGE_PATH, icon: <Sparkles /> }] }] : []),
        {
            title: t("navigation.sections.domains"),
            items: [{ name: t("domains.sidebar_title"), path: "/domains", icon: <Layers /> }]
        },
        {
            title: t("navigation.sections.frontends"),
            items: [
                { name: "Frontends", path: "/frontends", icon: <LayoutDashboard /> },
                { name: t("dependencies.sidebar_title"), path: "/dependencies", icon: <PackageIcon /> },
                { name: t("integration.sidebar_title"), path: "/integration", icon: <LinkIcon /> },
                { name: t("environmentVariables.title"), path: "/environment-variables", icon: <FileText /> }
            ]
        },
        {
            title: t("navigation.sections.backends"),
            items: [
                { name: t("backends.title"), path: "/backends", icon: <Server /> },
                { name: t("variableMaps.configMap.list_title"), path: "/config-maps", icon: <SlidersHorizontal /> },
                { name: t("variableMaps.secret.list_title"), path: "/secrets", icon: <KeyRound /> },
                { name: t("resources.list_title"), path: "/resources", icon: <Boxes /> }
            ]
        },
        {
            title: t("navigation.sections.maintenance"),
            items: [{ name: t("maintenance.sidebar_title"), path: "/maintenance-agents", icon: <Wrench /> }]
        },
        {
            title: t("navigation.sections.devops"),
            items: [
                { name: t("builds.title"), path: "/builds", icon: <HammerIcon /> },
                { name: t("deployments.title"), path: "/deployments", icon: <RocketIcon /> },
                // Missions run AI agents: without an AI in the project there is nothing to start.
                ...(assistantEnabled ? [{ name: t("fleet.title"), path: "/fleet", icon: <Ship /> }] : [])
            ]
        }
    ]

    return (
        <div className="w-screen h-screen overflow-y-auto md:flex md:flex-row md:gap-2 md:overflow-hidden">
            <Sidebar isCollapsed={isSidebarCollapsed} mainNavSections={mainNavSections} toggleCollapsed={toggleSidebar} />

            {/* Main content */}
            <div id="main_content" className="py-2 px-1 mt-2 flex-1 flex flex-col gap-2 transition-all duration-300 md:h-full md:overflow-y-auto md:mt-0">
                {/* Header */}
                <Header />
                {/* Page Content: la chat dell'agente scorre al suo interno, con la casella di testo sempre in vista. */}
                <main className={cn("flex-grow p-3 pb-0", isAssistantPage && "min-h-0")}>{children}</main>
            </div>

            {!isAssistantPage && <AssistantPanel />}

            <DeployOverlay />
        </div>
    )
}

export default MainLayout
