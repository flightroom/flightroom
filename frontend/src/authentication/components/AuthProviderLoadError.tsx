import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import AuthenticationLayout from "./AuthenticationLayout"

interface AuthProviderLoadErrorProps {
    /** The brand name of the login provider: Auth0, Microsoft */
    provider: string
}

/**
 * In place of the app when the SDK of a configured login provider cannot be downloaded: without it
 * nobody can tell whether the user is signed in. Reloading fetches the chunks of the current release.
 */
const AuthProviderLoadError: React.FC<AuthProviderLoadErrorProps> = ({ provider }) => {
    const { t } = useTranslation()

    return (
        <AuthenticationLayout title={t("auth.provider_load_error.title", { provider })} description={t("auth.provider_load_error.description")}>
            <Button className="w-full" onClick={() => window.location.reload()} dataTestId="auth-provider-reload">
                {t("auth.provider_load_error.reload")}
            </Button>
        </AuthenticationLayout>
    )
}

export default AuthProviderLoadError
