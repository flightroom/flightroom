import { Card, CardContent, CardHeader, CardTitle } from "@flightroom/design-system"
import { useMutation } from "@tanstack/react-query"
import React, { useState } from "react"
import { useTranslation } from "react-i18next"
import useEnvironmentsApi, { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import presetEnvironmentGroups, { EnvironmentPreset } from "@/utils/EnviromentsPresets"
import { EnvironmentList, EnvironmentSet } from "./index"

interface NoEnvironmentPlaceholderProps {
    onSaveSuccess: (environments: EnvironmentDTO[]) => void
    /** Set false to suppress the success toast (e.g. inside the wizard) */
    notifyOnSuccess?: boolean
    /** Environments to start the list from, e.g. the ones the assistant proposed in the wizard */
    initialEnvironments?: EnvironmentPreset[]
}

export const NoEnvironmentPlaceholder: React.FC<NoEnvironmentPlaceholderProps> = ({ onSaveSuccess, notifyOnSuccess = true, initialEnvironments }) => {
    const { t } = useTranslation()
    const [customEnvironments, setCustomEnvironments] = useState<EnvironmentPreset[] | undefined>(initialEnvironments)
    const environmentsApi = useEnvironmentsApi()
    const notificationToast = useToastNotificationStore()

    const handleAddPresetEnvs = (envs: EnvironmentPreset[]) => {
        const newEnvs = envs.map(env => ({ ...env }))
        setCustomEnvironments(newEnvs)
    }

    const saveEnvironmentsMutation = useMutation({
        mutationFn: async (environments: EnvironmentDTO[]) => {
            const newEnvironments = await environmentsApi.createEnvironmentsBulk(environments)
            if (notifyOnSuccess) {
                notificationToast.showSuccessNotification({
                    message: t("environment.created_success_message")
                })
            }
            onSaveSuccess(newEnvironments)
        }
    })

    return (
        <Card>
            <CardHeader>
                <CardTitle as="h2">{t("environment.configure")}</CardTitle>
            </CardHeader>
            <CardContent>
                <h3 className="text-sm font-medium uppercase text-foreground-secondary tracking-wide mb-2">{t("environment.preset_environments")}</h3>
                <div className="flex gap-4 flex-wrap">
                    {presetEnvironmentGroups.map(preset => (
                        <EnvironmentSet key={preset.name} name={preset.name} environments={preset.environments} onClick={handleAddPresetEnvs} />
                    ))}
                </div>
                <EnvironmentList
                    environments={customEnvironments}
                    onSaveEnvironments={async e => {
                        await saveEnvironmentsMutation.mutateAsync(e)
                    }}
                />
            </CardContent>
        </Card>
    )
}

export default NoEnvironmentPlaceholder
