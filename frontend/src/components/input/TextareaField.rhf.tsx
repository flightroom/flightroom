import { TextareaField as DesignSystemTextareaField } from "@flightroom/design-system"
import type { FieldValues } from "react-hook-form"
import { useTranslation } from "react-i18next"

type TextareaFieldProps<T extends FieldValues> = Parameters<typeof DesignSystemTextareaField<T>>[0]

/**
 * TextareaField del design system con le etichette tradotte: il toggle di visibilita, che con `secret` maschera
 * il contenuto, e il contatore dei caratteri, che compare con `maxLength`.
 */
const TextareaField = <T extends FieldValues>(props: TextareaFieldProps<T>) => {
    const { t, i18n } = useTranslation()
    const counterLabel = (current: number, max: number) => t("common.character_counter", { current: current.toLocaleString(i18n.language), max: max.toLocaleString(i18n.language) })

    return <DesignSystemTextareaField<T> showValueLabel={t("auth.show_password")} hideValueLabel={t("auth.hide_password")} counterLabel={counterLabel} {...props} />
}

export default TextareaField
