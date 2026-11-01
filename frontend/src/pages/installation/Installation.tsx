import { Alert, AlertDescription } from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { ApiStatusHandler } from "@/components/organisms"
import SinglePageLayout from "@/components/SinglePageLayout"
import useInstallationApi, { SANDBOX_SETTINGS_QUERY_KEY } from "@/hooks/apiClients/useInstallationApi"
import useUserStore from "@/store/useUserStore"
import { InstallationSandboxes } from "./partials/InstallationSandboxes"
import { SandboxPoolStatus } from "./partials/SandboxPoolStatus"
import { SandboxSettingsForm } from "./partials/SandboxSettingsForm"

/** The pool counts move as sandboxes are claimed and refilled: read again as often as the server reads the gateway. */
const REFRESH_MS = 30_000

/**
 * The settings of the whole installation, for its administrators (INSTALLATION_ADMINS): the sandboxes of the coding
 * agent, how they are created and kept, and the ones alive now. Anybody else is told it is not theirs to see.
 */
const Installation: React.FC = () => {
    const { t } = useTranslation()
    const { user } = useUserStore()
    const installationApi = useInstallationApi()
    const admin = user?.installationAdmin === true

    const settingsQuery = useQuery({ queryKey: [SANDBOX_SETTINGS_QUERY_KEY], queryFn: installationApi.getSandboxSettings, enabled: admin, refetchInterval: REFRESH_MS })

    return (
        <SinglePageLayout title={t("installation.title")} description={t("installation.subtitle")}>
            {admin ? (
                <div className="flex flex-col gap-6">
                    {/* Only the first load goes through ApiStatusHandler: it unmounts its children while a query fetches, so every
                        poll would flash the page and throw away what the admin is typing in the form */}
                    {settingsQuery.data ? (
                        <div className="flex flex-col gap-6">
                            <SandboxPoolStatus summary={settingsQuery.data} />
                            <SandboxSettingsForm summary={settingsQuery.data} />
                        </div>
                    ) : (
                        <ApiStatusHandler queries={[settingsQuery]}>{null}</ApiStatusHandler>
                    )}
                    <InstallationSandboxes />
                </div>
            ) : (
                <Alert variant="info" data-testid="installation-not-admin">
                    <AlertDescription>{t("installation.not_admin")}</AlertDescription>
                </Alert>
            )}
        </SinglePageLayout>
    )
}

export default Installation
