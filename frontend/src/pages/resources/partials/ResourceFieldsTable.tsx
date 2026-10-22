import { Card, CardContent, CardDescription, CardHeader, CardTitle, SelectField } from "@flightroom/design-system"
import { ChevronDown, ChevronRight, Eraser } from "lucide-react"
import { useState } from "react"
import { useFormContext, useWatch } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Badge, Button } from "@/components/atoms"
import TextareaField from "@/components/input/TextareaField.rhf"
import TextField from "@/components/input/TextField.rhf"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import type { ResourceFieldSpec } from "@/hooks/apiClients/useResourcesApi"
import { type CredentialToRetype, fieldLabel, optionLabel, type ResourceFieldFormValue } from "./resources"

/** The inputs that would trip the browser's own validation (url, email, number) are typed as text: the form says what is wrong */
const INPUT_MODES: Partial<Record<ResourceFieldSpec["input"], React.HTMLAttributes<HTMLInputElement>["inputMode"]>> = {
    number: "numeric",
    url: "url",
    email: "email"
}

/**
 * One value of a field, in the input its kind of field takes; a saved credential is never shown, only said to
 * be there. One to `retype` is not kept blank: where the resource connects changed.
 */
const FieldInput: React.FC<{ spec: ResourceFieldSpec; name: string; label: string; saved: boolean; retype?: boolean }> = ({ spec, name, label, saved, retype = false }) => {
    const { t } = useTranslation()
    const placeholder = retype ? t("resources.values.secret_retype") : spec.secret && saved ? t("resources.values.secret_keep") : t("resources.values.not_set")

    if (spec.input === "boolean" || spec.input === "select") {
        const options =
            spec.input === "boolean"
                ? [
                      { value: "true", label: t("resources.values.true") },
                      { value: "false", label: t("resources.values.false") }
                  ]
                : (spec.options ?? []).map(option => ({ value: option, label: optionLabel(t, spec.name, option) }))
        return (
            <SelectField
                name={name}
                label={label}
                options={options}
                placeholder={placeholder}
                addClearButton
                clearLabel={t("resources.values.clear_value")}
                containerClassName="flex-[1_1_220px]"
                className="w-full"
            />
        )
    }

    if (spec.input === "multiline") {
        return (
            <TextareaField
                name={name}
                label={label}
                placeholder={placeholder}
                secret={spec.secret}
                required={retype}
                rows={4}
                className="font-mono text-xs"
                autoComplete="off"
                containerClassName="flex-[1_1_100%]"
            />
        )
    }

    return (
        <TextField
            name={name}
            label={label}
            placeholder={placeholder}
            required={retype}
            type={spec.secret ? "password" : "text"}
            inputMode={INPUT_MODES[spec.input]}
            // Not a login: keep password managers from filling one in
            autoComplete={spec.secret ? "new-password" : "off"}
            containerClassName="flex-[1_1_220px]"
        />
    )
}

/** The mark of a credential: set or not, in all environments or in one */
const SecretStatus: React.FC<{ saved: boolean }> = ({ saved }) => {
    const { t } = useTranslation()
    return <Badge variant={saved ? "success" : "outline"}>{saved ? t("resources.values.set") : t("resources.values.unset")}</Badge>
}

/** A field of the variant: its variable, a value for all environments, and the environments that take another one */
const FieldRow: React.FC<{ spec: ResourceFieldSpec; envKey: string; environments: EnvironmentDTO[]; retype?: CredentialToRetype }> = ({ spec, envKey, environments, retype }) => {
    const { t } = useTranslation()
    const { setValue } = useFormContext()
    const path = `fields.${spec.name}`
    const current = useWatch({ name: path }) as ResourceFieldFormValue | undefined
    const overridden = current?.overrides.filter(override => override.value || override.saved).length ?? 0
    // Set in some environments only: one added later gets no value, so the backend refuses nothing then, but the variable is missing there
    const noValueForAll = spec.required && !spec.secret && !current?.value && overridden > 0
    // Open from the start when some environment already takes another value: it must not go unnoticed
    const [open, setOpen] = useState(overridden > 0)
    const label = fieldLabel(t, spec.name)

    const clear = (target: string) => setValue(`${target}.saved`, false, { shouldDirty: true })

    return (
        <div className="flex flex-col gap-2 rounded-md border border-divider p-3">
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">
                    {label}
                    {spec.required && !spec.secret && (
                        <span className="text-destructive" aria-hidden="true">
                            {" "}
                            *
                        </span>
                    )}
                </span>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{envKey}</code>
                {spec.secret && <SecretStatus saved={Boolean(current?.saved)} />}
                {!spec.required && <span className="text-xs text-foreground-secondary">{t("resources.values.optional")}</span>}
            </div>
            <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                <FieldInput spec={spec} name={`${path}.value`} label={t("resources.values.all_environments")} saved={Boolean(current?.saved)} retype={retype?.base} />
                {spec.secret && current?.saved && (
                    <Button type="button" variant="ghost" size="sm" className="mb-1" onClick={() => clear(path)}>
                        <Eraser />
                        {t("resources.values.clear_secret")}
                    </Button>
                )}
            </div>
            {noValueForAll && <p className="text-xs text-foreground-secondary">{t("resources.values.no_value_for_all")}</p>}
            {environments.length > 0 && (
                <Button type="button" variant="ghost" size="sm" className="self-start" aria-expanded={open} onClick={() => setOpen(!open)}>
                    {open ? <ChevronDown /> : <ChevronRight />}
                    {t("resources.values.overrides", { count: overridden })}
                </Button>
            )}
            {open && (
                <div className="flex flex-col gap-2 border-l-2 border-divider pl-3">
                    <p className="text-xs text-foreground-secondary">{t("resources.values.overrides_hint")}</p>
                    <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                        {environments.map((environment, index) => {
                            const saved = Boolean(current?.overrides[index]?.saved)
                            return (
                                <div key={environment._id} className="flex min-w-0 flex-[1_1_220px] items-end gap-1">
                                    <FieldInput spec={spec} name={`${path}.overrides.${index}.value`} label={environment.name} saved={saved} retype={retype?.overrides.includes(index)} />
                                    {spec.secret && saved && (
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon-sm"
                                            className="mb-1"
                                            aria-label={t("resources.values.clear_secret_in", { environment: environment.name })}
                                            title={t("resources.values.clear_secret_in", { environment: environment.name })}
                                            onClick={() => clear(`${path}.overrides.${index}`)}
                                        >
                                            <Eraser />
                                        </Button>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                </div>
            )}
        </div>
    )
}

/** The values of the fields of the variant, drawn from the catalog: a type added to it later works as it is */
export const ResourceFieldsTable: React.FC<{ fields: ResourceFieldSpec[]; prefix: string; environments: EnvironmentDTO[]; retype?: CredentialToRetype[] }> = ({
    fields,
    prefix,
    environments,
    retype = []
}) => {
    const { t } = useTranslation()

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("resources.values.title")}</CardTitle>
                <CardDescription>{t("resources.values.description")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 pt-3">
                {fields.length === 0 && <p className="text-sm text-foreground-secondary">{t("resources.values.none")}</p>}
                {fields.map(spec => (
                    <FieldRow key={spec.name} spec={spec} envKey={`${prefix}_${spec.envSuffix}`} environments={environments} retype={retype.find(credential => credential.field === spec.name)} />
                ))}
            </CardContent>
        </Card>
    )
}

export default ResourceFieldsTable
