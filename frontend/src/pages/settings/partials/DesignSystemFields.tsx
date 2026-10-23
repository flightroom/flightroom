import { type FieldValues, type Path, useFormContext } from "react-hook-form"
import { useTranslation } from "react-i18next"
import TextareaField from "@/components/input/TextareaField.rhf"
import TextField from "@/components/input/TextField.rhf"
import type { DesignSystem } from "@/hooks/apiClients/useProjectApi"

/** Gli stessi controlli del backend: un nome di pacchetto npm, con o senza scope, e documentazione su http(s) */
export const NPM_PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
export const HTTP_URL = /^https?:\/\/\S+$/

export interface DesignSystemFormValues {
    packageName: string
    version: string
    docsUrl: string
    npmrc: string
    notes: string
}

const FIELDS = ["packageName", "version", "docsUrl", "npmrc", "notes"] as const

export const designSystemFormValues = (designSystem?: DesignSystem | null): DesignSystemFormValues => ({
    packageName: designSystem?.packageName ?? "",
    version: designSystem?.version ?? "",
    docsUrl: designSystem?.docsUrl ?? "",
    npmrc: designSystem?.npmrc ?? "",
    notes: designSystem?.notes ?? ""
})

/** Il design system da inviare, senza i campi vuoti: `null`, che per l'API vuol dire "nessuno", quando manca il pacchetto */
export const toDesignSystem = (values?: Partial<DesignSystemFormValues>): DesignSystem | null => {
    const packageName = values?.packageName?.trim()
    if (!packageName) return null
    const optional = Object.fromEntries(FIELDS.filter(field => field !== "packageName" && values?.[field]?.trim()).map(field => [field, values?.[field]?.trim()]))
    return { packageName, ...optional }
}

interface DesignSystemFieldsProps {
    /** Il percorso dei campi nel form, es. "designSystem." in quello del frontend */
    prefix?: string
    /** Il pacchetto serve anche a form vuoto: chi ha scelto un design system proprio deve dire quale */
    required?: boolean
    dataTestId: string
}

/**
 * I campi di un design system, del progetto o di un frontend. Le regole valgono per i form senza resolver: quello
 * del frontend usa zod, che le ignora e le ripete.
 */
export const DesignSystemFields = <T extends FieldValues>({ prefix = "", required = false, dataTestId }: DesignSystemFieldsProps) => {
    const { t } = useTranslation()
    const { getValues } = useFormContext<T>()
    const path = (field: keyof DesignSystemFormValues) => `${prefix}${field}` as Path<T>

    const validatePackageName = (value: string) => {
        const packageName = value?.trim() ?? ""
        if (!packageName) {
            const othersFilled = FIELDS.some(field => field !== "packageName" && String(getValues(path(field)) ?? "").trim())
            return required || othersFilled ? t("designSystem.fields.packageNameRequired") : true
        }
        return NPM_PACKAGE_NAME.test(packageName) || t("designSystem.fields.packageNameInvalid")
    }

    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-x-4 gap-y-2">
                <TextField<T>
                    name={path("packageName")}
                    label={t("designSystem.fields.packageName")}
                    placeholder="@acme/ui"
                    description={t("designSystem.fields.packageNameHint")}
                    containerClassName="flex-[2_1_240px]"
                    dataTestId={`${dataTestId}-package`}
                    rules={{ validate: validatePackageName }}
                />
                <TextField<T>
                    name={path("version")}
                    label={t("designSystem.fields.version")}
                    placeholder="^3.2.0"
                    description={t("designSystem.fields.versionHint")}
                    containerClassName="flex-[1_1_160px]"
                    dataTestId={`${dataTestId}-version`}
                />
            </div>
            <TextField<T>
                name={path("docsUrl")}
                label={t("designSystem.fields.docsUrl")}
                placeholder="https://ui.acme.dev"
                dataTestId={`${dataTestId}-docs`}
                rules={{ validate: (value: string) => !value?.trim() || HTTP_URL.test(value.trim()) || t("designSystem.fields.docsUrlInvalid") }}
            />
            <TextareaField<T>
                name={path("npmrc")}
                label={t("designSystem.fields.npmrc")}
                placeholder={"@acme:registry=https://npm.acme.dev/\n//npm.acme.dev/:_authToken=..."}
                description={t("designSystem.fields.npmrcHint")}
                rows={5}
                className="font-mono text-sm"
                secret
                dataTestId={`${dataTestId}-npmrc`}
            />
            <TextareaField<T>
                name={path("notes")}
                label={t("designSystem.fields.notes")}
                placeholder={t("designSystem.fields.notesPlaceholder")}
                description={t("designSystem.fields.notesHint")}
                rows={6}
                className="font-mono text-sm"
                dataTestId={`${dataTestId}-notes`}
            />
        </div>
    )
}

export default DesignSystemFields
