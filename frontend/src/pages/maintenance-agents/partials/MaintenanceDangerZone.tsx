import { ConfirmByTypingDialog, DangerZoneCard } from "@flightroom/design-system"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Trash2 } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import useMaintenanceAgentsApi, { MaintenanceAgent } from "@/hooks/apiClients/useMaintenanceAgentsApi"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import { MAINTENANCE_LIST_PATH } from "./maintenance"

export const MaintenanceDangerZone: React.FC<{ agent: MaintenanceAgent }> = ({ agent }) => {
    const [opened, setOpened] = useState(false)
    const { deleteSingle } = useMaintenanceAgentsApi()
    const notifications = useToastNotificationStore()
    const queryClient = useQueryClient()
    const navigate = useNavigate()
    const { t } = useTranslation()

    const deleteMutation = useMutation({
        mutationFn: () => deleteSingle(agent._id),
        onSuccess: async () => {
            notifications.showSuccessNotification({ message: t("maintenance.dangerZone.success") })
            await queryClient.invalidateQueries({ queryKey: ["maintenance-agents"] })
            navigate(MAINTENANCE_LIST_PATH)
        }
    })

    return (
        <DangerZoneCard
            title={t("maintenance.dangerZone.title")}
            description={t("maintenance.dangerZone.subtitle")}
            actionTitle={t("maintenance.dangerZone.action_title")}
            actionDescription={t("maintenance.dangerZone.action_description")}
            actionLabel={t("maintenance.dangerZone.button")}
            actionIcon={<Trash2 />}
            onAction={() => setOpened(true)}
        >
            <ConfirmByTypingDialog
                open={opened}
                onOpenChange={setOpened}
                expectedText={agent.name}
                onConfirm={async () => {
                    await deleteMutation.mutateAsync()
                }}
                isPending={deleteMutation.isPending}
                title={t("maintenance.dangerZone.dialog.title")}
                warningTitle={t("maintenance.dangerZone.dialog.warning")}
                warningDescription={t("maintenance.dangerZone.dialog.description", { name: agent.name })}
                confirmationHint={t("maintenance.dangerZone.dialog.confirmation", { name: agent.name })}
                placeholder={agent.name}
                confirmLabel={t("maintenance.dangerZone.dialog.confirm")}
                confirmingLabel={t("common.deleting")}
                cancelLabel={t("common.cancel")}
                closeLabel={t("common.close")}
            />
        </DangerZoneCard>
    )
}

export default MaintenanceDangerZone
