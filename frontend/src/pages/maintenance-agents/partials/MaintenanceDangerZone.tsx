import { ConfirmByTypingDialog, DangerZoneCard } from "@flightroom/design-system"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { KeyRound, Trash2 } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import useMaintenanceAgentsApi, { MaintenanceAgent } from "@/hooks/apiClients/useMaintenanceAgentsApi"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import { MAINTENANCE_LIST_PATH } from "./maintenance"

export const MaintenanceDangerZone: React.FC<{ agent: MaintenanceAgent }> = ({ agent }) => {
    const [opened, setOpened] = useState(false)
    const [revoking, setRevoking] = useState(false)
    const { deleteSingle, revokeTokens } = useMaintenanceAgentsApi()
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

    const revokeMutation = useMutation({
        mutationFn: () => revokeTokens(agent._id),
        onSuccess: ({ revoked }) => {
            notifications.showSuccessNotification({ message: t("maintenance.tokens.success", { count: revoked }) })
            setRevoking(false)
        }
    })

    return (
        <div className="space-y-4">
            <DangerZoneCard
                title={t("maintenance.tokens.title")}
                description={t("maintenance.tokens.subtitle")}
                actionTitle={t("maintenance.tokens.action_title")}
                actionDescription={t("maintenance.tokens.action_description")}
                actionLabel={t("maintenance.tokens.button")}
                actionIcon={<KeyRound />}
                onAction={() => setRevoking(true)}
            >
                <ConfirmByTypingDialog
                    open={revoking}
                    onOpenChange={setRevoking}
                    expectedText={agent.name}
                    onConfirm={async () => {
                        await revokeMutation.mutateAsync()
                    }}
                    isPending={revokeMutation.isPending}
                    title={t("maintenance.tokens.dialog.title")}
                    warningTitle={t("maintenance.tokens.dialog.warning")}
                    warningDescription={t("maintenance.tokens.dialog.description", { name: agent.name })}
                    confirmationHint={t("maintenance.tokens.dialog.confirmation", { name: agent.name })}
                    placeholder={agent.name}
                    confirmLabel={t("maintenance.tokens.dialog.confirm")}
                    confirmingLabel={t("maintenance.tokens.dialog.confirming")}
                    cancelLabel={t("common.cancel")}
                    closeLabel={t("common.close")}
                />
            </DangerZoneCard>
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
        </div>
    )
}

export default MaintenanceDangerZone
