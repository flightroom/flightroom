import { Card, CardContent, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { Pencil, PlusCircle, ServerCog, Trash2 } from "lucide-react"
import React, { useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import SinglePageLayout from "@/components/SinglePageLayout"
import { DeleteConfirmationDialog } from "@/components/ui/DeleteConfirmationDialog"
import useMongoServersApi, { MongoServer, MongoServerProvider } from "@/hooks/apiClients/useMongoServersApi"
import useProjectStore from "@/store/useProjectStore"

export const MongoServers: React.FC = () => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const projectStore = useProjectStore()
    const mongoServersApi = useMongoServersApi()

    const [serverToDelete, setServerToDelete] = useState<MongoServer | null>(null)

    const serversQuery = useQuery({
        queryKey: ["mongo-servers", projectStore.project?._id],
        queryFn: mongoServersApi.getAll
    })

    const handleCreate = () => {
        navigate("/mongo-servers/new")
    }

    // L'URI di amministrazione e' mascherato: di un server Atlas si vede il cluster, di Cosmos DB l'account, che non sono credenziali
    const addressOf = (server: MongoServer) => {
        if (server.provider === MongoServerProvider.ATLAS) return `${server.connection.groupId} / ${server.connection.clusterName}`
        if (server.provider === MongoServerProvider.COSMOS_MONGO_RU) return `${server.connection.resourceGroup} / ${server.connection.accountName}`
        return t("mongoServers.connectionStringHidden")
    }

    return (
        <ApiStatusHandler queries={[serversQuery]}>
            <SinglePageLayout
                title={t("mongoServers.title")}
                description={t("mongoServers.description")}
                right={
                    serversQuery.data?.length > 0 ? (
                        <Button onClick={handleCreate} dataTestId="mongo-server-new">
                            <PlusCircle />
                            {t("mongoServers.newServer")}
                        </Button>
                    ) : null
                }
            >
                {serversQuery.data?.length > 0 ? (
                    <Table framed>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t("mongoServers.name")}</TableHead>
                                <TableHead>{t("mongoServers.provider")}</TableHead>
                                <TableHead>{t("mongoServers.address")}</TableHead>
                                <TableHead />
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {serversQuery.data.map(server => (
                                <TableRow key={server._id} data-testid={`mongo-server-row-${server.name}`}>
                                    <TableCell className="font-medium flex items-center gap-4">
                                        <ServerCog className="h-6 w-6 text-muted-foreground" />
                                        {server.name}
                                    </TableCell>
                                    <TableCell>{t(`mongoServers.providers.${server.provider}`)}</TableCell>
                                    <TableCell className="font-mono text-sm">{addressOf(server)}</TableCell>
                                    <TableCell>
                                        <div className="flex justify-end gap-2">
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-label={t("common.edit")}
                                                onClick={() => navigate(`/mongo-servers/${server._id}`)}
                                                dataTestId={`mongo-server-edit-${server.name}`}
                                            >
                                                <Pencil />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-label={t("common.delete")}
                                                className="text-destructive hover:bg-destructive/15 hover:text-destructive-active"
                                                onClick={() => setServerToDelete(server)}
                                                dataTestId={`mongo-server-delete-${server.name}`}
                                            >
                                                <Trash2 />
                                            </Button>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                ) : (
                    <Card>
                        <CardContent>
                            <EmptyState
                                size="sm"
                                description={t("mongoServers.noServersFound")}
                                actions={
                                    <Button onClick={handleCreate} dataTestId="mongo-server-new">
                                        <PlusCircle />
                                        {t("mongoServers.newServer")}
                                    </Button>
                                }
                            />
                        </CardContent>
                    </Card>
                )}

                <DeleteConfirmationDialog
                    isOpen={serverToDelete !== null}
                    onOpenChange={open => !open && setServerToDelete(null)}
                    onDelete={async () => {
                        if (serverToDelete) {
                            await mongoServersApi.deleteSingle(serverToDelete._id)
                        }
                    }}
                    // Ricaricare durante la cancellazione smonterebbe la pagina, dialog compreso, sotto lo spinner
                    onDeleteSuccess={() => {
                        setServerToDelete(null)
                        serversQuery.refetch()
                    }}
                    title={t("common.delete")}
                    description={serverToDelete ? t("mongoServers.deleteDescription", { name: serverToDelete.name }) : ""}
                />
            </SinglePageLayout>
        </ApiStatusHandler>
    )
}

export default MongoServers
