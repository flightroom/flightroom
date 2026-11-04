import { Card, CardContent, CardDescription, CardHeader, CardTitle, SwitchField as Switch } from "@flightroom/design-system"
import { Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import { useFieldArray, useFormContext } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import TextField from "@/components/input/TextField.rhf"
import { DeleteConfirmationDialog } from "@/components/ui/DeleteConfirmationDialog"

/** The environment variables the container expects: only the definition lives here, never a value. */
export const BackendEnvFields: React.FC = () => {
    const { t } = useTranslation()
    const { control, getValues } = useFormContext()
    const { fields, append, remove } = useFieldArray({ control, name: "env" })
    const [toRemove, setToRemove] = useState<{ index: number; name: string }>()

    const askRemove = (index: number) => {
        const { name, description } = getValues(`env.${index}`) ?? {}
        // A row just added and still empty goes without asking: there is nothing to lose.
        if (!name && !description) return remove(index)
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
                    <Button type="button" variant="secondary" size="sm" onClick={() => append({ name: "", required: false, secret: false, description: "" })}>
                        <Plus />
                        {t("backends.env.add")}
                    </Button>
                </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 pt-3">
                {fields.length === 0 && <p className="text-sm text-foreground-secondary">{t("backends.env.empty")}</p>}
                {fields.map((field, index) => (
                    <div key={field.id} className="flex flex-wrap items-end gap-x-4 gap-y-2 rounded-md border border-divider p-3">
                        <TextField
                            name={`env.${index}.name`}
                            label={t("backends.env.name")}
                            placeholder="DATABASE_URL"
                            textTransform={value => value.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}
                            required
                            containerClassName="flex-[1_1_200px]"
                        />
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
                ))}
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
