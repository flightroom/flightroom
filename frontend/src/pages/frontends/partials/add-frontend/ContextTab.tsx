import { Card, CardContent, CardDescription, CardHeader, CardTitle, SwitchField } from "@flightroom/design-system"
import { useTranslation } from "react-i18next"
import TextareaField from "@/components/input/TextareaField.rhf"
import { DesignSystemFields } from "@/pages/settings/partials/DesignSystemFields"
import { CONTEXT_MAX_LENGTH } from "@/pages/settings/partials/ProjectContextSection"
import useOrganizationStore from "@/store/useOrganizationStore"
import useProjectStore from "@/store/useProjectStore"
import type { FormInput } from "./frontendFormSchema"

/** The notes for the agents, and the design system it builds with */
export const ContextTab: React.FC<{ designSystemOverride?: boolean }> = ({ designSystemOverride }) => {
    const { t } = useTranslation()
    // The design system a frontend without its own builds with: the project's, else the organization's
    const projectDesignSystem = useProjectStore().project?.designSystem
    const organizationDesignSystem = useOrganizationStore().organization?.designSystem

    return (
        <div className="flex flex-col gap-6">
            <Card>
                <CardHeader>
                    <CardTitle className="mb-0">{t("frontend.context.title")}</CardTitle>
                    <CardDescription>{t("frontend.context.subtitle")}</CardDescription>
                </CardHeader>
                <CardContent className="pt-3">
                    <TextareaField
                        name="context"
                        maxLength={CONTEXT_MAX_LENGTH}
                        label={t("frontend.context.label")}
                        placeholder={t("frontend.context.placeholder")}
                        description={t("frontend.context.hint")}
                        rows={12}
                        className="font-mono text-sm"
                        dataTestId="frontend-context"
                    />
                </CardContent>
            </Card>
            <Card>
                <CardHeader>
                    <CardTitle className="mb-0">{t("designSystem.frontend.title")}</CardTitle>
                    <CardDescription>{t("designSystem.frontend.subtitle")}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4 pt-3">
                    <SwitchField<FormInput>
                        name="designSystemOverride"
                        label={t("designSystem.frontend.override")}
                        description={t("designSystem.frontend.overrideHint")}
                        dataTestId="frontend-design-system-override"
                    />
                    {designSystemOverride ? (
                        <DesignSystemFields<FormInput> prefix="designSystem." dataTestId="frontend-design-system" />
                    ) : (
                        <p className="text-sm text-muted-foreground" data-testid="frontend-design-system-inherited">
                            {projectDesignSystem?.packageName
                                ? t("designSystem.frontend.inherited", { packageName: projectDesignSystem.packageName })
                                : organizationDesignSystem?.packageName
                                  ? t("designSystem.frontend.inheritedFromOrganization", { packageName: organizationDesignSystem.packageName })
                                  : t("designSystem.frontend.noProjectDefault")}
                        </p>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}
