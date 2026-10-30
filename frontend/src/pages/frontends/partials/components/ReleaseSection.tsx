import { Card, CardContent, CardDescription, CardHeader, CardTitle, SelectField, SliderField, SwitchField as Switch } from "@flightroom/design-system"
import { useWatch } from "react-hook-form"
import { useTranslation } from "react-i18next"
import TextField from "@/components/input/TextField.rhf"
import { CanaryDeploymentType, CanaryType } from "@/hooks/apiClients/useFrontendsApi"
import { CANARY_DEPLOYMENT_TYPE_LABEL_KEYS, CANARY_TYPE_DESCRIPTION_KEYS, CANARY_TYPE_LABEL_KEYS } from "../labels"

const WATCHED_FIELDS = ["canary.enabled", "canary.deploymentType", "canary.type", "version"] as const

interface ReleaseSectionProps {
    isEdit?: boolean
    versions?: string[]
    /** Served by its own container, a backend or a DOCKER frontend: its version is the tag of its image. */
    container?: boolean
}

/** Version and canary settings: the two knobs that decide what gets served, in the General tab where the page opens. */
export const ReleaseSection: React.FC<ReleaseSectionProps> = ({ isEdit, versions, container = false }) => {
    const { t } = useTranslation()
    // useWatch and not watch: watch re-renders the whole form at each keystroke in these fields
    const [canaryEnabled, deploymentType, watchedCanaryType, version] = useWatch({ name: WATCHED_FIELDS })
    const canaryType = (watchedCanaryType as CanaryType | undefined) ?? CanaryType.ON_SESSION
    const hasVersionHistory = Boolean(isEdit && versions && versions.length > 0)
    // On User is an explicit enrolment, not a split: there is no traffic share to set, so asking for a
    // percentage would only suggest it does something.
    const isPercentageBased = canaryType !== CanaryType.ON_USER
    // A container is one Flightroom cannot split traffic for: no canary. Its version is the tag of its image,
    // typed here or set by its pipeline, with no bundle to pick from
    const isDocker = container

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("frontend.release_settings")}</CardTitle>
                <CardDescription>{t(isDocker ? "frontend.release_settings_container_description" : "frontend.release_settings_description")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 pt-3">
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {isDocker ? (
                        <TextField
                            name="version"
                            label={t("frontend.version")}
                            placeholder={t("frontend.version_placeholder")}
                            description={t("frontend.kind.version_from_pipeline")}
                            containerClassName="flex-[1_1_240px]"
                        />
                    ) : hasVersionHistory ? (
                        <>
                            <SelectField
                                name="version"
                                label={t("frontend.version")}
                                options={[
                                    ...versions.map(version => ({
                                        value: version,
                                        label: version
                                    })),
                                    { value: "custom", label: t("frontend.custom_version") }
                                ]}
                                required
                                containerClassName="flex-[1_1_240px]"
                                className="w-full"
                            />
                            {version === "custom" && (
                                <TextField
                                    name="customVersion"
                                    label={t("frontend.custom_version")}
                                    textTransform={value => value.replace(" ", "")}
                                    placeholder={t("frontend.version_placeholder")}
                                    required
                                    containerClassName="flex-[1_1_240px]"
                                />
                            )}
                        </>
                    ) : (
                        <TextField name="version" label={t("frontend.version")} placeholder={t("frontend.version_placeholder")} required containerClassName="flex-[1_1_240px]" />
                    )}
                </div>

                {!isDocker && (
                    <div className="border-t border-border pt-4">
                        <div className="flex items-end justify-between flex-wrap gap-x-4 gap-y-2">
                            <div>
                                <h3 className="text-base font-semibold m-0">{t("frontend.canary_settings")}</h3>
                                <p className="text-foreground-secondary text-sm m-0">{t("frontend.canary_settings_description")}</p>
                            </div>
                            <Switch name="canary.enabled" />
                        </div>

                        {canaryEnabled && (
                            <div className="flex flex-col gap-2 pt-3">
                                {isPercentageBased && (
                                    <SliderField
                                        name="canary.percentage"
                                        label={t("frontend.canary_percentage")}
                                        unit="%"
                                        min={0}
                                        max={100}
                                        presets={[5, 10, 25, 50]}
                                        presetsLabel={t("frontend.canary_percentage_presets")}
                                        required
                                    />
                                )}
                                <div className="flex flex-wrap gap-x-4 gap-y-2">
                                    <SelectField
                                        name="canary.type"
                                        label={t("frontend.canary_type")}
                                        options={Object.values(CanaryType).map(type => ({
                                            value: type,
                                            label: t(CANARY_TYPE_LABEL_KEYS[type])
                                        }))}
                                        required
                                        containerClassName="flex-[1_1_240px]"
                                        className="w-full"
                                    />
                                    <SelectField
                                        name="canary.deploymentType"
                                        label={t("frontend.deployment_type")}
                                        options={Object.values(CanaryDeploymentType).map(type => ({
                                            value: type,
                                            label: t(CANARY_DEPLOYMENT_TYPE_LABEL_KEYS[type])
                                        }))}
                                        required
                                        containerClassName="flex-[1_1_240px]"
                                        className="w-full"
                                    />
                                </div>
                                {/* The three types behave in genuinely different ways, and the name of each is not enough to tell them apart. */}
                                <p className="text-foreground-secondary text-sm m-0">{t(CANARY_TYPE_DESCRIPTION_KEYS[canaryType])}</p>
                                {deploymentType === CanaryDeploymentType.BASED_ON_VERSION && <TextField name="canary.version" label={t("frontend.canary_version")} placeholder="1.1.0" required />}
                                {deploymentType === CanaryDeploymentType.BASED_ON_URL && (
                                    <TextField name="canary.url" label={t("frontend.canary_url")} placeholder="https://canary.example.com" required />
                                )}
                            </div>
                        )}
                    </div>
                )}
            </CardContent>
        </Card>
    )
}
