import { Alert, AlertDescription, Card, CardContent, CardDescription, CardHeader, CardTitle, Popover, PopoverContent, PopoverTrigger, SearchInput } from "@flightroom/design-system"
import { Plus, X } from "lucide-react"
import { useState } from "react"
import { Controller, useFormContext, useWatch } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { Button } from "@/components/atoms"
import type { VariableMap, VariableMapKind } from "@/hooks/apiClients/useVariableMapsApi"
import { VARIABLE_MAP_KINDS } from "@/pages/variable-maps/partials/variableMaps"

const FIELD: Record<VariableMapKind, "configMapIds" | "secretIds"> = {
    configMap: "configMapIds",
    secret: "secretIds"
}

/** The maps of one kind the service attaches, each removable, and a search to add the others */
const MapChoices: React.FC<{ kind: VariableMapKind; maps: VariableMap[] }> = ({ kind, maps }) => {
    const { t } = useTranslation()
    const { control } = useFormContext()
    const { listPath, i18n: prefix } = VARIABLE_MAP_KINDS[kind]
    const [open, setOpen] = useState(false)
    const [searchTerm, setSearchTerm] = useState("")

    const keysOf = (map: VariableMap) => (map.entries.length > 0 ? map.entries.map(entry => entry.key).join(", ") : t("variableMaps.entries.empty"))

    return (
        <fieldset className="flex min-w-0 flex-[1_1_280px] flex-col gap-2">
            <legend className="mb-2 flex w-full items-baseline justify-between gap-2 text-sm font-semibold">
                {t(`${prefix}.list_title`)}
                <Link to={listPath} className="text-xs font-normal underline-offset-4 hover:underline">
                    {t("variableMaps.attach.manage")}
                </Link>
            </legend>
            {maps.length === 0 ? (
                <p className="text-sm text-foreground-secondary">{t(`${prefix}.empty_title`)}</p>
            ) : (
                <Controller
                    control={control}
                    name={FIELD[kind]}
                    render={({ field }) => {
                        const selected: string[] = field.value ?? []
                        const attached = maps.filter(map => selected.includes(map._id!))
                        const term = searchTerm.trim().toLowerCase()
                        const candidates = maps.filter(
                            map => !selected.includes(map._id!) && (!term || map.name.toLowerCase().includes(term) || map.entries.some(entry => entry.key.toLowerCase().includes(term)))
                        )
                        const allAttached = attached.length === maps.length

                        return (
                            <div className="flex flex-col gap-2">
                                {attached.length > 0 && (
                                    <ul className="flex flex-col divide-y divide-divider rounded-md border border-divider">
                                        {attached.map(map => (
                                            <li key={map._id} className="flex items-center gap-3 py-2 pl-3 pr-2">
                                                <div className="min-w-0 flex-1">
                                                    <span className="block truncate font-mono text-sm font-medium">{map.name}</span>
                                                    <span className="block truncate text-xs text-foreground-secondary">{keysOf(map)}</span>
                                                </div>
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="icon-sm"
                                                    aria-label={t("variableMaps.attach.detach", { name: map.name })}
                                                    title={t("variableMaps.attach.detach", { name: map.name })}
                                                    onClick={() => field.onChange(selected.filter(id => id !== map._id))}
                                                >
                                                    <X />
                                                </Button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                <Popover
                                    open={open}
                                    onOpenChange={next => {
                                        setOpen(next)
                                        if (!next) setSearchTerm("")
                                    }}
                                >
                                    <PopoverTrigger asChild>
                                        <Button type="button" variant="secondary" size="sm" className="self-start" disabled={allAttached}>
                                            <Plus />
                                            {allAttached ? t("variableMaps.attach.all_attached") : t(`${prefix}.attach`)}
                                        </Button>
                                    </PopoverTrigger>
                                    <PopoverContent align="start" className="flex w-80 flex-col gap-2 p-2">
                                        <SearchInput
                                            autoFocus
                                            value={searchTerm}
                                            onValueChange={setSearchTerm}
                                            onClear={() => setSearchTerm("")}
                                            clearLabel={t("variableMaps.attach.clear_search")}
                                            placeholder={t("variableMaps.attach.search_placeholder")}
                                        />
                                        {candidates.length > 0 ? (
                                            <ul className="flex max-h-64 flex-col overflow-y-auto">
                                                {candidates.map(map => (
                                                    <li key={map._id}>
                                                        <button
                                                            type="button"
                                                            className="w-full rounded-md px-2 py-1.5 text-left hover:bg-primary/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                                            onClick={() => {
                                                                field.onChange([...selected, map._id!])
                                                                setOpen(false)
                                                                setSearchTerm("")
                                                            }}
                                                        >
                                                            <span className="block truncate font-mono text-sm font-medium">{map.name}</span>
                                                            <span className="block truncate text-xs text-foreground-secondary">{keysOf(map)}</span>
                                                        </button>
                                                    </li>
                                                ))}
                                            </ul>
                                        ) : (
                                            <p className="px-2 py-4 text-center text-sm text-foreground-secondary">{t("variableMaps.attach.no_results", { searchTerm })}</p>
                                        )}
                                    </PopoverContent>
                                </Popover>
                            </div>
                        )
                    }}
                />
            )}
        </fieldset>
    )
}

/**
 * The config maps and the secrets the service receives as environment variables. They live in their own
 * sections and can be shared: here they are only attached.
 */
export const ServiceVariableMapsFields: React.FC<{
    configMaps: VariableMap[]
    secrets: VariableMap[]
}> = ({ configMaps, secrets }) => {
    const { t } = useTranslation()
    const [configMapIds = [], secretIds = []] = useWatch({ name: ["configMapIds", "secretIds"] }) as [string[] | undefined, string[] | undefined]

    // The backend refuses it as well: said here, the user sees it before saving
    const owners = new Map<string, string>()
    let clash: { key: string; first: string; second: string } | undefined
    for (const map of [...configMaps.filter(map => configMapIds.includes(map._id!)), ...secrets.filter(map => secretIds.includes(map._id!))]) {
        for (const { key } of map.entries) {
            const owner = owners.get(key)
            if (owner !== undefined && !clash) clash = { key, first: owner, second: map.name }
            owners.set(key, map.name)
        }
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("variableMaps.attach.title")}</CardTitle>
                <CardDescription>{t("variableMaps.attach.description")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 pt-3">
                <div className="flex flex-wrap gap-4">
                    <MapChoices kind="configMap" maps={configMaps} />
                    <MapChoices kind="secret" maps={secrets} />
                </div>
                {clash && (
                    <Alert variant="destructive">
                        <AlertDescription>{t("variableMaps.errors.key_clash", clash)}</AlertDescription>
                    </Alert>
                )}
            </CardContent>
        </Card>
    )
}

export default ServiceVariableMapsFields
