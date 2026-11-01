import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@flightroom/design-system"
import { useMutation } from "@tanstack/react-query"
import { Eye, EyeOff } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { Badge, Button } from "@/components/atoms"
import type { Backend } from "@/hooks/apiClients/useBackendsApi"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import useVariableMapsApi, { type VariableMap, type VariableMapEntry, type VariableMapKind } from "@/hooks/apiClients/useVariableMapsApi"
import VariableEntriesTable from "@/pages/variable-maps/partials/VariableEntriesTable"
import { VARIABLE_MAP_KINDS } from "@/pages/variable-maps/partials/variableMaps"
import { useIsProjectViewer } from "@/store/useProjectStore"

/** One attached map and its keys; a secret shows its values on request, to whoever may change it, until hidden again */
const AttachedMap: React.FC<{ kind: VariableMapKind; map: VariableMap; environments: EnvironmentDTO[] }> = ({ kind, map, environments }) => {
    const { t } = useTranslation()
    const { reveal } = useVariableMapsApi("secret")
    const viewer = useIsProjectViewer()
    const [revealed, setRevealed] = useState<VariableMapEntry[]>()
    const revealQuery = useMutation({ mutationFn: () => reveal(map._id!), onSuccess: setRevealed })

    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
                <Link to={VARIABLE_MAP_KINDS[kind].detailPath(map._id!)} className="font-mono font-semibold underline-offset-4 hover:underline">
                    {map.name}
                </Link>
                <Badge variant="outline">{t(`${VARIABLE_MAP_KINDS[kind].i18n}.label`)}</Badge>
                {kind === "secret" && !viewer && (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto"
                        onClick={() => (revealed ? setRevealed(undefined) : revealQuery.mutate())}
                        loading={revealQuery.isPending}
                        loadingLabel={t("variableMaps.secret.revealing")}
                    >
                        {revealed ? <EyeOff /> : <Eye />}
                        {revealed ? t("variableMaps.secret.hide_values") : t("variableMaps.secret.show_values")}
                    </Button>
                )}
            </div>
            <VariableEntriesTable kind={kind} entries={revealed ?? map.entries} environments={environments} revealed={!!revealed} />
        </div>
    )
}

/** What the backend receives from the config maps and the secrets it attaches, a table per map */
export const BackendVariableMapsSection: React.FC<{ backend: Pick<Backend, "configMapIds" | "secretIds">; configMaps: VariableMap[]; secrets: VariableMap[]; environments: EnvironmentDTO[] }> = ({
    backend,
    configMaps,
    secrets,
    environments
}) => {
    const { t } = useTranslation()
    const attached: Array<[VariableMapKind, VariableMap]> = [
        ...configMaps.filter(map => backend.configMapIds?.includes(map._id!)).map(map => ["configMap", map] as [VariableMapKind, VariableMap]),
        ...secrets.filter(map => backend.secretIds?.includes(map._id!)).map(map => ["secret", map] as [VariableMapKind, VariableMap])
    ]

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("variableMaps.attach.title")}</CardTitle>
                <CardDescription>{t("variableMaps.attach.detail_description")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-6 pt-3">
                {attached.length === 0 && <p className="text-sm text-foreground-secondary">{t("variableMaps.attach.none")}</p>}
                {attached.map(([kind, map]) => (
                    <AttachedMap key={`${kind}-${map._id}`} kind={kind} map={map} environments={environments} />
                ))}
            </CardContent>
        </Card>
    )
}

export default BackendVariableMapsSection
