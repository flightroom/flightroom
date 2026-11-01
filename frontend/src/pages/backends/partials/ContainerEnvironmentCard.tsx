import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Select,
    SelectContent,
    SelectControl,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow
} from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import useContainerEnvironmentApi, { type ContainerKind, type ContainerVariable } from "@/hooks/apiClients/useContainerEnvironmentApi"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import { useIsProjectViewer } from "@/store/useProjectStore"

const ValueCell: React.FC<{ variable: ContainerVariable }> = ({ variable }) => {
    const { t } = useTranslation()
    if (variable.masked) {
        return (
            <span className="text-foreground-secondary">
                {variable.masked.length === undefined ? t("backends.injected_variables.masked") : t("backends.injected_variables.masked_length", { length: variable.masked.length })}
            </span>
        )
    }
    return <code className="break-all text-xs">{variable.value}</code>
}

/** The variables the running container of a backend or of a DOCKER frontend got in one environment, read from its live pod */
export const ContainerEnvironmentCard: React.FC<{ kind: ContainerKind; id: string; environments: EnvironmentDTO[] }> = ({ kind, id, environments }) => {
    const { t } = useTranslation()
    const { get } = useContainerEnvironmentApi()
    // A viewer does not read what runs, as with the logs
    const isViewer = useIsProjectViewer()
    const [chosenId, setChosenId] = useState<string>()
    // The first environment until one is chosen: the list may still be loading on the first render
    const environmentId = chosenId ?? environments[0]?._id
    const selected = environments.find(environment => environment._id === environmentId)

    const query = useQuery({
        queryKey: ["container-environment", kind, id, environmentId],
        queryFn: () => get(kind, id, environmentId!),
        enabled: Boolean(environmentId) && !isViewer
    })
    const data = query.data

    if (isViewer) return null

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("backends.injected_variables.title")}</CardTitle>
                <CardDescription>{t("backends.injected_variables.description")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 pt-3">
                <SelectControl label={t("backends.injected_variables.environment")}>
                    <Select value={environmentId} onValueChange={setChosenId}>
                        <SelectTrigger dataTestId="injected-variables-environment">
                            <SelectValue placeholder={t("backends.injected_variables.environment")}>{selected?.name}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            {environments.map(environment => (
                                <SelectItem key={environment._id} value={environment._id!}>
                                    {environment.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </SelectControl>
                <ApiStatusHandler queries={[query]}>
                    {data?.state === "no_pod" && <p className="text-sm text-foreground-secondary">{t("backends.injected_variables.no_pod")}</p>}
                    {data?.state === "running" && (
                        <div className="flex flex-col gap-3">
                            <p className="text-sm text-foreground-secondary">
                                {t("backends.injected_variables.running", { pod: data.pod, startedAt: data.startedAt ? new Date(data.startedAt).toLocaleString() : "—" })}
                            </p>
                            <Table>
                                <TableHeader tinted={false}>
                                    <TableRow>
                                        <TableHead>{t("backends.injected_variables.name")}</TableHead>
                                        <TableHead>{t("backends.injected_variables.value")}</TableHead>
                                        <TableHead>{t("backends.injected_variables.source")}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {data.variables.map(variable => (
                                        <TableRow key={`${variable.source}:${variable.name}`} className={variable.overriddenBy ? "opacity-60" : undefined}>
                                            <TableCell>
                                                <code className={variable.overriddenBy ? "text-xs line-through" : "text-xs"}>{variable.name}</code>
                                            </TableCell>
                                            <TableCell>
                                                <ValueCell variable={variable} />
                                            </TableCell>
                                            <TableCell>
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <Badge variant="outline">{variable.source === "platform" ? t("backends.injected_variables.platform") : variable.source}</Badge>
                                                    {variable.overriddenBy && (
                                                        <span className="text-xs text-foreground-secondary">
                                                            {t("backends.injected_variables.overridden_by", {
                                                                source: variable.overriddenBy === "platform" ? t("backends.injected_variables.platform") : variable.overriddenBy
                                                            })}
                                                        </span>
                                                    )}
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </div>
                    )}
                    {data?.notes?.map(note => (
                        <p key={note} className="text-sm text-foreground-secondary">
                            {note}
                        </p>
                    ))}
                </ApiStatusHandler>
            </CardContent>
        </Card>
    )
}

export default ContainerEnvironmentCard
