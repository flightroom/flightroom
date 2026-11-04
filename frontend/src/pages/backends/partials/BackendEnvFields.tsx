import { Card, CardContent, CardDescription, CardHeader, CardTitle, SwitchField as Switch } from "@flightroom/design-system"
import { Eraser, Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import { useFieldArray, useFormContext, useWatch } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import TextField from "@/components/input/TextField.rhf"
import { DeleteConfirmationDialog } from "@/components/ui/DeleteConfirmationDialog"
import type { BackendEnvVariable } from "@/hooks/apiClients/useBackendsApi"

/**
 * The environment variables Flightroom injects into the container on every deploy, the same value in every environment.
 * The server never sends back the value of a secret one, only `valueSet`: left blank, the stored value is kept.
 */
export const BackendEnvFields: React.FC = () => {
    const { t } = useTranslation()
    const { control, getValues, setValue } = useFormContext()
    const { fields, append, remove } = useFieldArray({ control, name: "env" })
    const rows = (useWatch({ control, name: "env" }) ?? []) as BackendEnvVariable[]
    const [toRemove, setToRemove] = useState<{ index: number; name: string }>()

    const askRemove = (index: number) => {
        const { name, description, value, valueSet } = getValues(`env.${index}`) ?? {}
        // A row just added and still empty goes without asking: there is nothing to lose.
        if (!name && !description && !value && !valueSet) return remove(index)
        setToRemove({ index, name: name || "" })
    }

    return (
        <Card>
            <CardHeader>
                <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
                    <div>
                        <CardTitle className="mb-0">{t("backends.env.title")}</CardTitle>
                        <CardDescription>{t("backends.env.description")}</CardDescription>
                    </div>
                    <Button type="button" variant="secondary" size="sm" onClick={() => append({ name: "", value: "", required: false, secret: false, description: "" })}>
                        <Plus />
                        {t("backends.env.add")}
                    </Button>
                </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 pt-3">
                {fields.length === 0 && <p className="text-sm text-foreground-secondary">{t("backends.env.empty")}</p>}
                {fields.map((field, index) => {
                    const row = rows[index]
                    // A secret value the server holds and nobody retyped: kept on save unless cleared
                    const kept = Boolean(row?.secret && row.valueSet && !row.value)
                    return (
                        <div key={field.id} className="flex flex-wrap items-end gap-x-4 gap-y-2 rounded-md border border-divider p-3">
                            <TextField
                                name={`env.${index}.name`}
                                label={t("backends.env.name")}
                                placeholder="DATABASE_URL"
                                textTransform={value => value.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}
                                required
                                containerClassName="flex-[1_1_200px]"
                            />
                            <div className="flex min-w-0 flex-[2_1_240px] items-end gap-1">
                                <TextField
                                    name={`env.${index}.value`}
                                    label={t("backends.env.value")}
                                    type={row?.secret ? "password" : "text"}
                                    autoComplete={row?.secret ? "new-password" : "off"}
                                    placeholder={kept ? t("backends.env.value_set_placeholder") : t("backends.env.value_placeholder")}
                                    containerClassName="min-w-0 flex-1"
                                />
                                {kept && (
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        aria-label={t("backends.env.clear_value")}
                                        title={t("backends.env.clear_value")}
                                        onClick={() => setValue(`env.${index}.valueSet`, false, { shouldDirty: true })}
                                    >
                                        <Eraser />
                                    </Button>
                                )}
                            </div>
                            <TextField name={`env.${index}.description`} label={t("backends.env.variable_description")} containerClassName="flex-[2_1_240px]" />
                            <div className="flex items-end gap-4">
                                {/* The switches carry their label above: the padding brings the toggle onto the inputs' centre line. */}
                                <div className="flex items-end gap-4 pb-2">
                                    <Switch name={`env.${index}.required`} label={t("backends.env.required")} />
                                    <Switch name={`env.${index}.secret`} label={t("backends.env.secret")} />
                                </div>
                                <Button type="button" variant="ghost" size="icon" aria-label={t("backends.env.remove")} title={t("backends.env.remove")} onClick={() => askRemove(index)}>
                                    <Trash2 className="text-destructive" />
                                </Button>
                            </div>
                        </div>
                    )
                })}
            </CardContent>
            <DeleteConfirmationDialog
                isOpen={Boolean(toRemove)}
                onOpenChange={open => !open && setToRemove(undefined)}
                onDelete={() => {
                    if (toRemove) remove(toRemove.index)
                    setToRemove(undefined)
                }}
                title={t("backends.env.confirm_remove_title")}
                description={t("backends.env.confirm_remove", { name: toRemove?.name ?? "" })}
            />
        </Card>
    )
}

export default BackendEnvFields
