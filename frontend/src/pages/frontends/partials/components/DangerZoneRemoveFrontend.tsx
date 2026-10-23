import { ConfirmByTypingDialog, DangerZoneCard } from "@flightroom/design-system"
import { useMutation } from "@tanstack/react-query"
import { Trash2 } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import useFrontendsApi, { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import useToastNotificationStore from "@/store/useToastNotificationStore"

interface IDangerZoneRemoveFrontendProps {
    frontend?: Frontend
}

export const DangerZoneRemoveFrontend: React.FC<IDangerZoneRemoveFrontendProps> = ({ frontend }) => {
    const [opened, setOpened] = useState(false)
    const { deleteSingle } = useFrontendsApi()
    const notificationToast = useToastNotificationStore()
    const navigate = useNavigate()
    const { t } = useTranslation()

    const deleteFrontendMutation = useMutation({
        mutationFn: () => deleteSingle(frontend!._id),
        onSuccess: () => {
            notificationToast.showSuccessNotification({
                message: t("frontend.dangerZone.delete.success")
            })
            navigate("/frontends")
        }
    })

    // Don't render if there's no frontend (creating new one)
    if (!frontend) {
        return null
    }

    return (
        <DangerZoneCard
            title={t("frontend.dangerZone.title")}
            description={t("frontend.dangerZone.subtitle")}
            actionTitle={t("frontend.dangerZone.delete.title")}
            actionDescription={t("frontend.dangerZone.delete.description")}
            actionLabel={t("frontend.dangerZone.delete.button")}
            actionIcon={<Trash2 />}
            onAction={() => setOpened(true)}
        >
            <ConfirmByTypingDialog
                open={opened}
                onOpenChange={setOpened}
                expectedText={frontend.name}
                onConfirm={async () => {
                    await deleteFrontendMutation.mutateAsync()
                }}
                isPending={deleteFrontendMutation.isPending}
                title={t("frontend.dangerZone.delete.dialog.title")}
                warningTitle={t("frontend.dangerZone.delete.dialog.warning")}
                warningDescription={
                    <>
                        {t("frontend.dangerZone.delete.dialog.description", { frontendName: frontend.name })}
                        <div className="mt-2">{t("frontend.dangerZone.delete.dialog.confirmation", { frontendName: frontend.name })}</div>
                    </>
                }
                confirmationHint={t("frontend.dangerZone.delete.dialog.confirmationText", { frontendName: frontend.name })}
                placeholder={frontend.name}
                confirmLabel={t("frontend.dangerZone.delete.dialog.confirmButton")}
                confirmingLabel={t("frontend.dangerZone.delete.dialog.deleting")}
                cancelLabel={t("common.cancel")}
                closeLabel={t("common.close")}
            />
        </DangerZoneCard>
    )
}

export default DangerZoneRemoveFrontend
