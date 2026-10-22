import { Card, CardContent, CardDescription, CardHeader, CardTitle, Popover, PopoverContent, PopoverTrigger, SearchInput } from "@flightroom/design-system"
import { Plus, X } from "lucide-react"
import { useState } from "react"
import { Controller, useFormContext } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { Badge, Button } from "@/components/atoms"
import type { Resource } from "@/hooks/apiClients/useResourcesApi"
import { RESOURCE_LIST_PATH, typeLabel } from "@/pages/resources/partials/resources"

/**
 * The resources the service attaches, each removable, and a search to add the others. They live in their
 * own section and can be shared: here they are only attached. Backend services only, never a frontend.
 */
export const ServiceResourcesFields: React.FC<{ resources: Resource[] }> = ({ resources }) => {
    const { t } = useTranslation()
    const { control } = useFormContext()
    const [open, setOpen] = useState(false)
    const [searchTerm, setSearchTerm] = useState("")

    const keysOf = (resource: Resource) => resource.env.map(key => key.key).join(", ")

    return (
        <Card>
            <CardHeader>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <CardTitle className="mb-0">{t("resources.attach.title")}</CardTitle>
                    <Link to={RESOURCE_LIST_PATH} className="text-xs font-normal underline-offset-4 hover:underline">
                        {t("resources.attach.manage")}
                    </Link>
                </div>
                <CardDescription>{t("resources.attach.description")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 pt-3">
                {resources.length === 0 ? (
                    <p className="text-sm text-foreground-secondary">{t("resources.empty_title")}</p>
                ) : (
                    <Controller
                        control={control}
                        name="resourceIds"
                        render={({ field }) => {
                            const selected: string[] = field.value ?? []
                            const attached = resources.filter(resource => selected.includes(resource._id!))
                            const term = searchTerm.trim().toLowerCase()
                            const candidates = resources.filter(
                                resource =>
                                    !selected.includes(resource._id!) &&
                                    (!term ||
                                        resource.name.toLowerCase().includes(term) ||
                                        typeLabel(t, resource.type).toLowerCase().includes(term) ||
                                        resource.env.some(key => key.key.toLowerCase().includes(term)))
                            )
                            const allAttached = attached.length === resources.length

                            return (
                                <div className="flex flex-col gap-2">
                                    {attached.length > 0 && (
                                        <ul className="flex flex-col divide-y divide-divider rounded-md border border-divider">
                                            {attached.map(resource => (
                                                <li key={resource._id} className="flex items-center gap-3 py-2 pl-3 pr-2">
                                                    <div className="min-w-0 flex-1">
                                                        <span className="flex items-center gap-2">
                                                            <span className="truncate font-mono text-sm font-medium">{resource.name}</span>
                                                            <Badge variant="outline">{typeLabel(t, resource.type)}</Badge>
                                                        </span>
                                                        <span className="block truncate text-xs text-foreground-secondary">{keysOf(resource)}</span>
                                                    </div>
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="icon-sm"
                                                        aria-label={t("resources.attach.detach", { name: resource.name })}
                                                        title={t("resources.attach.detach", { name: resource.name })}
                                                        onClick={() => field.onChange(selected.filter(id => id !== resource._id))}
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
                                                {allAttached ? t("resources.attach.all_attached") : t("resources.attach.add")}
                                            </Button>
                                        </PopoverTrigger>
                                        <PopoverContent align="start" className="flex w-80 flex-col gap-2 p-2">
                                            <SearchInput
                                                autoFocus
                                                value={searchTerm}
                                                onValueChange={setSearchTerm}
                                                onClear={() => setSearchTerm("")}
                                                clearLabel={t("resources.attach.clear_search")}
                                                placeholder={t("resources.attach.search_placeholder")}
                                            />
                                            {candidates.length > 0 ? (
                                                <ul className="flex max-h-64 flex-col overflow-y-auto">
                                                    {candidates.map(resource => (
                                                        <li key={resource._id}>
                                                            <button
                                                                type="button"
                                                                className="w-full rounded-md px-2 py-1.5 text-left hover:bg-primary/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                                                onClick={() => {
                                                                    field.onChange([...selected, resource._id!])
                                                                    setOpen(false)
                                                                    setSearchTerm("")
                                                                }}
                                                            >
                                                                <span className="flex items-center gap-2">
                                                                    <span className="truncate font-mono text-sm font-medium">{resource.name}</span>
                                                                    <span className="text-xs text-foreground-secondary">{typeLabel(t, resource.type)}</span>
                                                                </span>
                                                                <span className="block truncate text-xs text-foreground-secondary">{keysOf(resource)}</span>
                                                            </button>
                                                        </li>
                                                    ))}
                                                </ul>
                                            ) : (
                                                <p className="px-2 py-4 text-center text-sm text-foreground-secondary">{t("resources.attach.no_results", { searchTerm })}</p>
                                            )}
                                        </PopoverContent>
                                    </Popover>
                                </div>
                            )
                        }}
                    />
                )}
            </CardContent>
        </Card>
    )
}

export default ServiceResourcesFields
