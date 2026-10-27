import { Input } from "@flightroom/design-system"
import { Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import useDomainsApi from "@/hooks/apiClients/useDomainsApi"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import { StepShell, WizardFooter, WizardStepProps } from "./wizardShared"

interface Row {
    name: string
    description: string
}

const EMPTY_ROW: Row = { name: "", description: "" }

/** Functional domains step: the areas the frontends and backends will be grouped in, prefilled with the assistant's proposal */
const Domains: React.FC<WizardStepProps> = ({ onNext, onBack, onSkip, draft }) => {
    const { t } = useTranslation()
    const domainsApi = useDomainsApi()
    const notifications = useToastNotificationStore()
    const [loading, setLoading] = useState(false)
    const [rows, setRows] = useState<Row[]>(draft?.domains.length ? draft.domains.map(domain => ({ ...domain })) : [EMPTY_ROW])
    // Names already created: a retry after a partial failure does not create them twice.
    const [created, setCreated] = useState<string[]>([])

    const update = (i: number, patch: Partial<Row>) => setRows(prev => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
    const addRow = () => setRows(prev => [...prev, EMPTY_ROW])
    const removeRow = (i: number) => setRows(prev => prev.filter((_, idx) => idx !== i))

    const onSave = async () => {
        const valid = rows.map(r => ({ name: r.name.trim(), description: r.description.trim() })).filter(r => r.name)
        const names = valid.map(r => r.name.toLowerCase())
        const duplicate = valid.find((r, idx) => names.indexOf(r.name.toLowerCase()) !== idx)
        if (duplicate) {
            notifications.showWarningNotification({ message: t("newProjectWizard.domains.duplicate_name", { name: duplicate.name }) })
            return
        }
        setLoading(true)
        try {
            for (const row of valid.filter(r => !created.includes(r.name))) {
                await domainsApi.create({ name: row.name, description: row.description || undefined })
                setCreated(prev => [...prev, row.name])
            }
            onNext()
        } catch {
            // The API client already said what went wrong.
        } finally {
            setLoading(false)
        }
    }

    return (
        <StepShell
            title={t("newProjectWizard.domains.title")}
            description={t("newProjectWizard.domains.description")}
            skippableNote={t("newProjectWizard.domains.skippable_note")}
            footer={<WizardFooter onBack={onBack} onSkip={onSkip} onNext={onSave} loading={loading} nextLabel={t("newProjectWizard.domains.submit")} />}
        >
            <div className="flex flex-col gap-3">
                {rows.map((row, i) => (
                    <div key={i} className="flex flex-col gap-2 md:flex-row md:items-center">
                        <Input
                            data-testid={`wizard-domain-name-${i}`}
                            value={row.name}
                            maxLength={100}
                            onChange={e => update(i, { name: e.target.value })}
                            placeholder={t("newProjectWizard.domains.name_placeholder")}
                            aria-label={t("newProjectWizard.domains.name_label")}
                            className="md:w-56"
                        />
                        <div className="flex flex-1 items-center gap-2">
                            <Input
                                data-testid={`wizard-domain-description-${i}`}
                                value={row.description}
                                maxLength={2000}
                                onChange={e => update(i, { description: e.target.value })}
                                placeholder={t("newProjectWizard.domains.description_placeholder")}
                                aria-label={t("newProjectWizard.domains.description_label")}
                                className="flex-1"
                            />
                            <Button type="button" variant="ghost" size="icon" onClick={() => removeRow(i)} disabled={rows.length === 1} aria-label={t("newProjectWizard.domains.remove")}>
                                <Trash2 className="size-4" />
                            </Button>
                        </div>
                    </div>
                ))}

                <div>
                    <Button type="button" variant="ghost" size="sm" onClick={addRow}>
                        <Plus className="size-4" /> {t("newProjectWizard.domains.add")}
                    </Button>
                </div>
            </div>
        </StepShell>
    )
}

export default Domains
