import { RadioGroup, RadioGroupItem } from "@flightroom/design-system"
import { Controller, useFormContext } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { FrontendKind } from "@/hooks/apiClients/useFrontendsApi"
import { cn } from "@/utils/styleUtils"
import { KIND_DESCRIPTION_KEYS, KIND_LABEL_KEYS } from "../labels"

interface FrontendKindFieldProps {
    /** Created under a parent: it can only be a BUNDLE, so there is nothing to choose. */
    disabled?: boolean
    /** It already has parents, which a DOCKER cannot have. */
    dockerDisabled?: boolean
}

/** The only place the kind is chosen: the template does not set it. */
export const FrontendKindField: React.FC<FrontendKindFieldProps> = ({ disabled, dockerDisabled }) => {
    const { t } = useTranslation()
    const { control } = useFormContext()

    return (
        <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-semibold">{t("frontend.kind.label")}</legend>
            <Controller
                control={control}
                name="kind"
                render={({ field }) => (
                    <RadioGroup value={field.value} onValueChange={field.onChange} disabled={disabled} className="flex flex-wrap gap-3">
                        {Object.values(FrontendKind).map(kind => {
                            const optionDisabled = disabled || (kind === FrontendKind.DOCKER && dockerDisabled)
                            return (
                                <label
                                    key={kind}
                                    htmlFor={`frontend-kind-${kind}`}
                                    className={cn(
                                        "flex flex-[1_1_240px] cursor-pointer items-start gap-3 rounded-md border-2 border-border p-3 transition-colors",
                                        field.value === kind && "border-primary bg-primary/5",
                                        optionDisabled && "cursor-not-allowed opacity-60"
                                    )}
                                >
                                    <RadioGroupItem id={`frontend-kind-${kind}`} value={kind} disabled={optionDisabled} className="mt-0.5" />
                                    <span className="min-w-0">
                                        <span className="block text-sm font-semibold">{t(KIND_LABEL_KEYS[kind])}</span>
                                        <span className="block text-xs text-foreground-secondary">{t(KIND_DESCRIPTION_KEYS[kind])}</span>
                                    </span>
                                </label>
                            )
                        })}
                    </RadioGroup>
                )}
            />
            {(disabled || dockerDisabled) && <p className="m-0 text-sm text-foreground-secondary">{t("frontend.kind.no_parents_hint")}</p>}
        </fieldset>
    )
}

export default FrontendKindField
