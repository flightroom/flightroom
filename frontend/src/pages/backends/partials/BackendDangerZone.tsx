import { ConfirmByTypingDialog, DangerZoneCard } from "@flightroom/design-system"
import { useMutation } from "@tanstack/react-query"
import { Trash2 } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import useBackendsApi, { Backend } from "@/hooks/apiClients/useBackendsApi"
import useToastNotificationStore from "@/store/useToastNotificationStore"

export const BackendDangerZone: React.FC<{ backend: Backend }> = ({ backend }) => {
    const [opened, setOpened] = useState(false)
    const { deleteSingle } = useBackendsApi()
    const notifications = useToastNotificationStore()
    const navigate = useNavigate()
    const { t } = useTranslation()

    const deleteMutation = useMutation({
        mutationFn: () => deleteSingle(backend._id!),
        onSuccess: () => {
            notifications.showSuccessNotification({ message: t("backends.dangerZone.success") })
            navigate("/backends")
        }
    })

    return (
        <DangerZoneCard
            title={t("backends.dangerZone.title")}
            description={t("backends.dangerZone.subtitle")}
            actionTitle={t("backends.dangerZone.action_title")}
            actionDescription={t("backends.dangerZone.action_description")}
            actionLabel={t("backends.dangerZone.button")}
            actionIcon={<Trash2 />}
            onAction={() => setOpened(true)}
        >
            <ConfirmByTypingDialog
                open={opened}
                onOpenChange={setOpened}
                expectedText={backend.name}
                onConfirm={async () => {
                    await deleteMutation.mutateAsync()
                }}
                isPending={deleteMutation.isPending}
                title={t("backends.dangerZone.dialog.title")}
                warningTitle={t("backends.dangerZone.dialog.warning")}
                warningDescription={t("backends.dangerZone.dialog.description", { name: backend.name })}
                confirmationHint={t("backends.dangerZone.dialog.confirmation", { name: backend.name })}
                placeholder={backend.name}
                confirmLabel={t("backends.dangerZone.dialog.confirm")}
                confirmingLabel={t("common.deleting")}
                cancelLabel={t("common.cancel")}
                closeLabel={t("common.close")}
            />
        </DangerZoneCard>
    )
}

export default BackendDangerZone
