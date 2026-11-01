import { Checkbox, ConfirmByTypingDialog, DangerZoneCard, Label } from "@flightroom/design-system"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Trash2 } from "lucide-react"
import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import useDomainsApi, { type Domain } from "@/hooks/apiClients/useDomainsApi"
import useToastNotificationStore from "@/store/useToastNotificationStore"

/** Deletes the domain: its frontends and backends stay without a domain, unless the user asks to delete them too */
export const DomainDangerZone: React.FC<{ domain: Domain }> = ({ domain }) => {
    const [opened, setOpened] = useState(false)
    const [withMembers, setWithMembers] = useState(false)
    const { deleteSingle } = useDomainsApi()
    const queryClient = useQueryClient()
    const notifications = useToastNotificationStore()
    const navigate = useNavigate()
    const { t } = useTranslation()
    const id = useId()

    const deleteMutation = useMutation({
        mutationFn: () => deleteSingle(domain._id!, withMembers),
        onSuccess: async () => {
            notifications.showSuccessNotification({ message: t("domains.dangerZone.success") })
            await Promise.all(["domains", "frontends", "backends"].map(key => queryClient.invalidateQueries({ queryKey: [key] })))
            navigate("/domains")
        }
    })

    // Opened again, the dialog starts from keeping them: deleting them is asked for each time
    const onOpenChange = (open: boolean) => {
        setOpened(open)
        if (!open) setWithMembers(false)
    }

    return (
        <DangerZoneCard
            title={t("domains.dangerZone.title")}
            description={t("domains.dangerZone.subtitle")}
            actionTitle={t("domains.dangerZone.action_title")}
            actionDescription={t("domains.dangerZone.action_description")}
            actionLabel={t("domains.dangerZone.button")}
            actionIcon={<Trash2 />}
            onAction={() => setOpened(true)}
        >
            <ConfirmByTypingDialog
                open={opened}
                onOpenChange={onOpenChange}
                expectedText={domain.name}
                onConfirm={async () => {
                    await deleteMutation.mutateAsync()
                }}
                isPending={deleteMutation.isPending}
                title={t("domains.dangerZone.dialog.title")}
                warningTitle={t("domains.dangerZone.dialog.warning")}
                warningDescription={t(withMembers ? "domains.dangerZone.dialog.description_with_members" : "domains.dangerZone.dialog.description", { name: domain.name })}
                confirmationHint={t("domains.dangerZone.dialog.confirmation", { name: domain.name })}
                placeholder={domain.name}
                confirmLabel={t("domains.dangerZone.dialog.confirm")}
                confirmingLabel={t("common.deleting")}
                cancelLabel={t("common.cancel")}
                closeLabel={t("common.close")}
            >
                <div className="flex items-start gap-2">
                    <Checkbox id={`${id}-members`} checked={withMembers} onCheckedChange={checked => setWithMembers(checked === true)} />
                    <Label htmlFor={`${id}-members`} className="cursor-pointer leading-snug">
                        {t("domains.dangerZone.dialog.with_members")}
                    </Label>
                </div>
            </ConfirmByTypingDialog>
        </DangerZoneCard>
    )
}

export default DomainDangerZone
