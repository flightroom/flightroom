import { Alert, AlertDescription, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@flightroom/design-system"
import { Download, FileUp, Trash2, Undo2 } from "lucide-react"
import { useRef, useState } from "react"
import { useFormContext, useWatch } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Badge, Button } from "@/components/atoms"
import TextareaField from "@/components/input/TextareaField.rhf"
import useResourcesApi, { type Resource } from "@/hooks/apiClients/useResourcesApi"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import { byteLength, formatBytes, MAX_API_SPEC_BYTES } from "./resources"

const ACCEPTED_FILES = ".json,.yaml,.yml,application/json,application/yaml,application/x-yaml,text/yaml"

/**
 * The Swagger/OpenAPI document of an `api`, for when its specUrl cannot be reached: pasted, or loaded from a
 * file. It stays with the platform, never a variable: only whether there is one comes back, and its size.
 */
export const ResourceApiSpecFields: React.FC<{ resource?: Resource }> = ({ resource }) => {
    const { t } = useTranslation()
    const { setValue } = useFormContext()
    const notifications = useToastNotificationStore()
    const { getApiSpec } = useResourcesApi()
    const fileInputRef = useRef<HTMLInputElement>(null)
    const [downloading, setDownloading] = useState(false)
    const [typed = "", removed = false] = useWatch({ name: ["apiSpec", "apiSpecRemoved"] }) as [string | undefined, boolean | undefined]
    const stored = resource?.apiSpec?.present ? resource.apiSpec : undefined
    const maxSize = formatBytes(MAX_API_SPEC_BYTES)

    const onFileSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        // The same file picked again must fire a change
        event.target.value = ""
        if (!file) return
        if (file.size > MAX_API_SPEC_BYTES) {
            notifications.showErrorNotification({ message: t("resources.api_spec.too_large", { max: maxSize }) })
            return
        }
        try {
            setValue("apiSpec", await file.text(), { shouldDirty: true, shouldValidate: true })
        } catch {
            notifications.showErrorNotification({ message: t("resources.api_spec.read_failed") })
        }
    }

    const download = async () => {
        if (!resource?._id) return
        setDownloading(true)
        try {
            const spec = await getApiSpec(resource._id)
            const json = spec.trimStart().startsWith("{")
            const url = URL.createObjectURL(new Blob([spec], { type: json ? "application/json" : "application/yaml" }))
            const link = document.createElement("a")
            link.href = url
            link.download = `${resource.name}-openapi.${json ? "json" : "yaml"}`
            link.click()
            // After the click has started the download, not before
            setTimeout(() => URL.revokeObjectURL(url))
        } catch {
            notifications.showErrorNotification({ message: t("resources.api_spec.download_failed") })
        } finally {
            setDownloading(false)
        }
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("resources.api_spec.title")}</CardTitle>
                <CardDescription>{t("resources.api_spec.description")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 pt-3">
                <div className="flex flex-wrap items-center gap-2">
                    {stored && !removed ? (
                        <Badge variant="success">{t("resources.api_spec.present", { size: formatBytes(stored.bytes) })}</Badge>
                    ) : (
                        <Badge variant="outline">{t("resources.api_spec.none")}</Badge>
                    )}
                    <Button type="button" variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
                        <FileUp />
                        {t("resources.api_spec.upload")}
                    </Button>
                    {stored && !removed && (
                        <>
                            <Button type="button" variant="secondary" size="sm" disabled={downloading} onClick={download}>
                                <Download />
                                {t("resources.api_spec.download")}
                            </Button>
                            <Button
                                type="button"
                                variant="ghost-destructive"
                                size="sm"
                                onClick={() => {
                                    setValue("apiSpecRemoved", true, { shouldDirty: true })
                                    setValue("apiSpec", "", { shouldDirty: true, shouldValidate: true })
                                }}
                            >
                                <Trash2 />
                                {t("resources.api_spec.remove")}
                            </Button>
                        </>
                    )}
                    <input ref={fileInputRef} type="file" accept={ACCEPTED_FILES} className="hidden" aria-label={t("resources.api_spec.upload")} onChange={onFileSelected} />
                </div>
                {removed && (
                    <Alert>
                        <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                            {t("resources.api_spec.removed")}
                            <Button type="button" variant="ghost" size="sm" onClick={() => setValue("apiSpecRemoved", false, { shouldDirty: true })}>
                                <Undo2 />
                                {t("resources.api_spec.undo_remove")}
                            </Button>
                        </AlertDescription>
                    </Alert>
                )}
                <TextareaField
                    name="apiSpec"
                    label={t("resources.api_spec.label")}
                    placeholder={t("resources.api_spec.placeholder")}
                    description={stored && !removed ? t("resources.api_spec.hint_replace", { max: maxSize }) : t("resources.api_spec.hint", { max: maxSize })}
                    rows={10}
                    className="font-mono text-xs"
                    spellCheck={false}
                />
                {typed && <p className="text-xs text-foreground-secondary">{t("resources.api_spec.typed_size", { size: formatBytes(byteLength(typed)) })}</p>}
            </CardContent>
        </Card>
    )
}

export default ResourceApiSpecFields
