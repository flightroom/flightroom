import { Alert, AlertDescription, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, RadioGroup, RadioGroupItem } from "@flightroom/design-system"
import { TriangleAlert } from "lucide-react"
import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import type { EnvironmentDatabasesChoice } from "@/hooks/apiClients/useDatabaseApi"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"

/** Un database creato su un server MongoDB che alimenta una risorsa nell'ambiente, con i nomi da mostrare */
export interface LinkedDatabase {
    id: string
    databaseName: string
    server?: string
    resource?: string
}

const CHOICES: EnvironmentDatabasesChoice[] = ["unlink", "record", "user", "drop"]

interface EnvironmentDeleteWithDatabasesDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    environment: EnvironmentDTO
    databases: LinkedDatabase[]
    onDelete: (choice: EnvironmentDatabasesChoice, confirmName?: string) => Promise<void>
}

/**
 * L'eliminazione di un ambiente in cui dei database creati alimentano una risorsa: chiede cosa farne, per tutti.
 * Per cancellarne i dati si riscrive il nome dell'ambiente, una volta sola per tutti i database (e lo stesso per un
 * ambiente di produzione, come nel dialog senza database).
 */
export const EnvironmentDeleteWithDatabasesDialog: React.FC<EnvironmentDeleteWithDatabasesDialogProps> = ({ open, onOpenChange, environment, databases, onDelete }) => {
    const { t } = useTranslation()
    const idPrefix = useId()
    const [choice, setChoice] = useState<EnvironmentDatabasesChoice>("unlink")
    const [confirmName, setConfirmName] = useState("")
    const [isDeleting, setIsDeleting] = useState(false)
    const typesName = choice === "drop" || Boolean(environment.isProduction)
    const confirmed = !typesName || confirmName === environment.name

    // Il nome digitato non sopravvive alla chiusura: riaprendo, la conferma deve tornare una barriera
    const changeOpen = (next: boolean) => {
        if (!next) {
            setChoice("unlink")
            setConfirmName("")
        }
        onOpenChange(next)
    }

    const submit = async () => {
        if (!confirmed) return
        setIsDeleting(true)
        try {
            await onDelete(choice, choice === "drop" ? confirmName : undefined)
            setConfirmName("")
        } catch {
            // Il client delle API ha gia' mostrato perche', con i database gia' trattati
        } finally {
            setIsDeleting(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={changeOpen}>
            <DialogContent className="sm:max-w-[560px]" dataTestId="environment-delete-databases-dialog">
                <form
                    onSubmit={event => {
                        event.preventDefault()
                        submit()
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>{t("environment.page.delete.title")}</DialogTitle>
                        <DialogDescription>{t("environment.page.delete.databases.description", { name: environment.name })}</DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-4 py-4">
                        <ul className="list-disc pl-5 text-sm">
                            {databases.map(database => (
                                <li key={database.id}>
                                    <span className="font-mono">{database.databaseName}</span>{" "}
                                    {t("environment.page.delete.databases.item", { server: database.server ?? "", resource: database.resource ?? "" })}
                                </li>
                            ))}
                        </ul>
                        <RadioGroup
                            value={choice}
                            onValueChange={value => setChoice(value as EnvironmentDatabasesChoice)}
                            aria-label={t("environment.page.delete.databases.choiceLabel")}
                            dataTestId="environment-delete-databases-choice"
                        >
                            {CHOICES.map(candidate => (
                                <div key={candidate} className="flex items-start gap-2">
                                    <RadioGroupItem id={`${idPrefix}-${candidate}`} value={candidate} className="mt-0.5" />
                                    <Label htmlFor={`${idPrefix}-${candidate}`} className="flex cursor-pointer flex-col gap-0.5">
                                        <span>{t(`environment.page.delete.databases.choices.${candidate}`)}</span>
                                        <span className="text-xs font-normal text-foreground-secondary">{t(`environment.page.delete.databases.choices.${candidate}Hint`)}</span>
                                    </Label>
                                </div>
                            ))}
                        </RadioGroup>
                        {choice === "drop" && (
                            <Alert variant="destructive">
                                <TriangleAlert className="size-4" aria-hidden="true" />
                                <AlertDescription>{t("environment.page.delete.databases.dropWarning", { count: databases.length })}</AlertDescription>
                            </Alert>
                        )}
                        {typesName && (
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor={`${idPrefix}-confirm`}>{t("environment.page.delete.production_hint", { name: environment.name })}</Label>
                                <Input
                                    id={`${idPrefix}-confirm`}
                                    value={confirmName}
                                    onChange={event => setConfirmName(event.target.value)}
                                    placeholder={environment.name}
                                    autoComplete="off"
                                    dataTestId="environment-delete-databases-confirm"
                                />
                            </div>
                        )}
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="secondary" onClick={() => changeOpen(false)} disabled={isDeleting}>
                            {t("common.cancel")}
                        </Button>
                        <Button type="submit" variant="destructive" disabled={!confirmed} loading={isDeleting} loadingLabel={t("common.deleting")} dataTestId="environment-delete-databases-submit">
                            {t("common.delete")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    )
}

export default EnvironmentDeleteWithDatabasesDialog
