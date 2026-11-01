import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import * as z from "zod"
import TextareaField from "@/components/input/TextareaField.rhf"
import TextField from "@/components/input/TextField.rhf"
import { CONTEXT_MAX_LENGTH } from "../../settings/partials/ProjectContextSection"

const createFormSchema = (nameMessage: string, contextMessage: string) =>
    z.object({
        name: z.string().trim().min(1, nameMessage).max(100),
        description: z.string().optional(),
        context: z.string().max(CONTEXT_MAX_LENGTH, contextMessage).optional()
    })

export type DomainFormValues = z.infer<ReturnType<typeof createFormSchema>>

/** The rules of the name and of the AI context, with their messages: shared by the wizards and the settings of the domain */
export const useDomainFormSchema = () => {
    const { t } = useTranslation()
    return useMemo(() => createFormSchema(t("domains.form.name_required"), t("settings.projectContext.tooLong", { max: CONTEXT_MAX_LENGTH })), [t])
}

/** Name, description and AI context of a domain, inside the form that holds them */
export const DomainFormFields: React.FC<{ disabled?: boolean }> = ({ disabled }) => {
    const { t } = useTranslation()
    return (
        <>
            <TextField name="name" label={t("domains.form.name")} placeholder={t("domains.form.name_placeholder")} required disabled={disabled} dataTestId="domain-name" />
            <TextareaField name="description" label={t("domains.form.description_label")} placeholder={t("domains.form.description_placeholder")} disabled={disabled} />
            <TextareaField
                name="context"
                maxLength={CONTEXT_MAX_LENGTH}
                label={t("domains.form.context_label")}
                placeholder={t("domains.form.context_placeholder")}
                description={t("domains.form.context_hint")}
                rows={8}
                className="font-mono text-sm"
                disabled={disabled}
                dataTestId="domain-context"
            />
        </>
    )
}
