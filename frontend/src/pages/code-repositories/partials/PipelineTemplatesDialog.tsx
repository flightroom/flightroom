import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    Select,
    SelectContent,
    SelectControl,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Switch
} from "@flightroom/design-system"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import useCodeRepositoriesApi, { type ICodeRepository, type PipelineTemplatesDTO } from "@/hooks/apiClients/useCodeRepositoriesApi"
import useGitOpsErrorMessage from "@/hooks/apiClients/useGitOpsErrorMessage"
import { SettingsDetails } from "@/pages/settings/partials/SettingsDetails"
import useToastNotificationStore from "@/store/useToastNotificationStore"

/** Stessa regola del backend: un nome di branch o di tag, senza "..", trattino iniziale, slash finale o ".lock" */
const GIT_REF_PATTERN = /^(?!-)(?!.*\.\.)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._/-]{1,255}$/

/** Stessa regola del backend: una cartella relativa, nomi separati da slash, senza "." né ".." */
const PIPELINES_PATH_PATTERN = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

/** `/ci/templates/` e `ci/templates` sono la stessa cartella, come per il backend */
const normalizePath = (path: string) => path.trim().replace(/^\/+|\/+$/g, "")

interface PipelineTemplatesDialogProps {
    /** La connessione di cui si scelgono i template di pipeline; null a dialog chiuso */
    connection: ICodeRepository | null
    onOpenChange: (open: boolean) => void
}

export const PipelineTemplatesDialog: React.FC<PipelineTemplatesDialogProps> = ({ connection, onOpenChange }) => {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const codeRepositoriesApi = useCodeRepositoriesApi()
    const gitOpsErrorMessage = useGitOpsErrorMessage()
    const notifications = useToastNotificationStore()

    const [enabled, setEnabled] = useState(false)
    const [repositoryId, setRepositoryId] = useState<string | undefined>()
    const [ref, setRef] = useState("")
    const [path, setPath] = useState("")

    const pipelines = connection?.pipelines?.codeRepository ? connection.pipelines : undefined

    // Ogni apertura riparte da quanto salvato sulla connessione
    useEffect(() => {
        setEnabled(Boolean(pipelines))
        setRepositoryId(pipelines?.codeRepository.repositoryId)
        setRef(pipelines?.ref ?? "")
        setPath(pipelines?.path ?? "")
    }, [connection?._id, pipelines])

    // Il repository dei template si legge sempre tramite questa connessione: solo quelli che raggiunge davvero
    const repositoriesQuery = useQuery({
        queryKey: ["importable-repositories", connection?._id, "backend"],
        queryFn: () => codeRepositoriesApi.getImportableRepositories(connection!._id, undefined, "backend"),
        enabled: !!connection && enabled
    })

    const saveMutation = useMutation({
        mutationFn: (values: PipelineTemplatesDTO) => codeRepositoriesApi.setPipelines(connection!._id, values, gitOpsErrorMessage),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["code-repositories", connection?.projectId] })
            notifications.showSuccessNotification({ message: t("codeRepositories.pipelines.saved") })
            onOpenChange(false)
        }
    })

    const isUpdating = saveMutation.isPending
    const repositories = repositoriesQuery.data ?? []
    const selectedRepositoryName =
        repositories.find(repository => repository.repositoryId === repositoryId)?.name ?? (repositoryId === pipelines?.codeRepository.repositoryId ? pipelines?.codeRepository.name : undefined)
    const refInvalid = ref.trim() !== "" && !GIT_REF_PATTERN.test(ref.trim())
    const pathInvalid = normalizePath(path) !== "" && (normalizePath(path).length > 255 || !PIPELINES_PATH_PATTERN.test(normalizePath(path)))
    const canSave = !enabled || (!!repositoryId && !refInvalid && !pathInvalid)

    const buildValues = (): PipelineTemplatesDTO => (enabled ? { repositoryId: repositoryId!, ref: ref.trim() || null, path: normalizePath(path) || null } : null)

    return (
        <Dialog open={!!connection} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[600px]">
                <DialogHeader>
                    <DialogTitle>{t("codeRepositories.pipelines.title", { name: connection?.name })}</DialogTitle>
                    <DialogDescription>{t("codeRepositories.pipelines.subtitle")}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4 py-4">
                    <SettingsDetails summary={t("settings.howItWorks")} dataTestId="pipelines-details">
                        <p>{t("codeRepositories.pipelines.details")}</p>
                        <p>{t("codeRepositories.pipelines.layout")}</p>
                        <p>{t("codeRepositories.pipelines.placeholders")}</p>
                    </SettingsDetails>

                    <div className="flex items-center gap-3">
                        <Switch id="pipelines-enabled" checked={enabled} disabled={isUpdating} onCheckedChange={setEnabled} />
                        <Label htmlFor="pipelines-enabled">{t("codeRepositories.pipelines.enabled")}</Label>
                    </div>

                    {enabled && (
                        <>
                            <SelectControl label={t("codeRepositories.pipelines.repository")}>
                                <Select value={repositoryId} onValueChange={setRepositoryId} disabled={isUpdating || repositoriesQuery.isLoading}>
                                    <SelectTrigger dataTestId="pipelines-repository">
                                        <SelectValue placeholder={t("codeRepositories.pipelines.repositoryPlaceholder")}>{selectedRepositoryName}</SelectValue>
                                    </SelectTrigger>
                                    <SelectContent>
                                        {repositories.map(repository => (
                                            <SelectItem key={repository.repositoryId} value={repository.repositoryId}>
                                                {repository.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </SelectControl>

                            <div className="flex flex-col gap-1">
                                <Label htmlFor="pipelines-ref">{t("codeRepositories.pipelines.ref")}</Label>
                                <Input
                                    id="pipelines-ref"
                                    value={ref}
                                    placeholder={t("codeRepositories.pipelines.refPlaceholder")}
                                    disabled={isUpdating}
                                    aria-invalid={refInvalid}
                                    aria-describedby="pipelines-ref-hint"
                                    onChange={event => setRef(event.target.value)}
                                    fullWidth
                                />
                                <span id="pipelines-ref-hint" className={refInvalid ? "text-xs text-destructive" : "text-xs text-foreground-secondary"}>
                                    {t(refInvalid ? "codeRepositories.pipelines.refInvalid" : "codeRepositories.pipelines.refHint")}
                                </span>
                            </div>

                            <div className="flex flex-col gap-1">
                                <Label htmlFor="pipelines-path">{t("codeRepositories.pipelines.path")}</Label>
                                <Input
                                    id="pipelines-path"
                                    value={path}
                                    placeholder={t("codeRepositories.pipelines.pathPlaceholder")}
                                    disabled={isUpdating}
                                    aria-invalid={pathInvalid}
                                    aria-describedby="pipelines-path-hint"
                                    onChange={event => setPath(event.target.value)}
                                    fullWidth
                                />
                                <span id="pipelines-path-hint" className={pathInvalid ? "text-xs text-destructive" : "text-xs text-foreground-secondary"}>
                                    {t(pathInvalid ? "codeRepositories.pipelines.pathInvalid" : "codeRepositories.pipelines.pathHint")}
                                </span>
                            </div>
                        </>
                    )}
                </div>

                <DialogFooter>
                    <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={isUpdating}>
                        {t("common.cancel")}
                    </Button>
                    <Button type="button" disabled={!canSave} loading={isUpdating} loadingLabel={t("common.loading")} dataTestId="pipelines-save" onClick={() => saveMutation.mutate(buildValues())}>
                        {t("common.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}

export default PipelineTemplatesDialog
