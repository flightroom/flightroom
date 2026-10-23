import { Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Label } from "@flightroom/design-system"
import { Plus, Trash2 } from "lucide-react"
import { useEffect } from "react"
import { FieldError, get, useFieldArray, useFormContext, useWatch } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import TextField from "@/components/input/TextField.rhf"
import type { ResourceCustomField } from "@/hooks/apiClients/useResourcesApi"
import { emptyFormField, MAX_RESOURCE_CUSTOM_FIELDS, type ResourceFieldFormValue } from "./resources"

/**
 * The variables a `generic` resource defines: a name, the end of the variable, and whether it is a credential.
 * Their values are typed in the values table below, as those of any field. A variable turned secret or plain
 * starts over with no value, as the backend drops the stored one: a credential never comes back readable.
 */
export const ResourceCustomFieldsEditor: React.FC<{ prefix: string; environmentCount: number }> = ({ prefix, environmentCount }) => {
    const { t } = useTranslation()
    const {
        control,
        getValues,
        setValue,
        formState: { errors }
    } = useFormContext()
    const { fields, append, remove } = useFieldArray({ control, name: "customFields" })
    const customFields = (useWatch({ control, name: "customFields" }) as ResourceCustomField[] | undefined) ?? []
    const names = customFields.map(field => field.name).join("\n")

    // Every variable has its values in the form, one just added or renamed too: the values table reads them by name
    useEffect(() => {
        const values = (getValues("fields") ?? {}) as Record<string, ResourceFieldFormValue>
        for (const name of names.split("\n")) if (name && !values[name]) setValue(`fields.${name}`, emptyFormField(environmentCount))
    }, [names, environmentCount, getValues, setValue])

    const toggleSecret = (index: number, secret: boolean) => {
        setValue(`customFields.${index}.secret`, secret, { shouldDirty: true })
        const name = customFields[index]?.name
        if (name) setValue(`fields.${name}`, emptyFormField(environmentCount), { shouldDirty: true })
    }

    return (
        <Card>
            <CardHeader>
                <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
                    <div>
                        <CardTitle className="mb-0">{t("resources.custom_fields.title")}</CardTitle>
                        <CardDescription>{t("resources.custom_fields.description")}</CardDescription>
                    </div>
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={fields.length >= MAX_RESOURCE_CUSTOM_FIELDS}
                        onClick={() => append({ name: "", secret: false } satisfies ResourceCustomField)}
                    >
                        <Plus />
                        {t("resources.custom_fields.add")}
                    </Button>
                </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 pt-3">
                {fields.length === 0 && <p className="text-sm text-foreground-secondary">{t("resources.custom_fields.empty")}</p>}
                {fields.map((field, index) => {
                    // The design system TextField looks errors up by the flat name, which misses one inside a list
                    const nameError = get(errors, `customFields.${index}.name`) as FieldError | undefined
                    const checkboxId = `resource-custom-field-${field.id}-secret`
                    const name = customFields[index]?.name ?? ""

                    return (
                        <div key={field.id} className="flex flex-col gap-1 rounded-md border border-divider p-3">
                            <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                                <TextField
                                    name={`customFields.${index}.name`}
                                    label={t("resources.custom_fields.name")}
                                    placeholder="API_TOKEN"
                                    description={name ? `${prefix}_${name}` : undefined}
                                    textTransform={value => value.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}
                                    autoComplete="off"
                                    required
                                    containerClassName="flex-[1_1_240px]"
                                />
                                <div className="mt-8 flex items-center gap-2">
                                    <Checkbox id={checkboxId} checked={Boolean(customFields[index]?.secret)} onCheckedChange={checked => toggleSecret(index, checked === true)} />
                                    <Label htmlFor={checkboxId} className="cursor-pointer">
                                        {t("resources.custom_fields.secret")}
                                    </Label>
                                </div>
                                <Button type="button" variant="secondary" size="sm" className="mt-7" aria-label={t("common.remove")} title={t("common.remove")} onClick={() => remove(index)}>
                                    <Trash2 />
                                </Button>
                            </div>
                            {nameError?.message && (
                                <p role="alert" className="text-sm font-medium text-destructive">
                                    {nameError.message}
                                </p>
                            )}
                        </div>
                    )
                })}
                {fields.length > 0 && <p className="text-xs text-foreground-secondary">{t("resources.custom_fields.hint")}</p>}
            </CardContent>
        </Card>
    )
}

export default ResourceCustomFieldsEditor
