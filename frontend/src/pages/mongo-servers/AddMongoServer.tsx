import { Alert, AlertDescription, Card, CardContent, CardDescription, CardHeader, CardTitle, SelectField } from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { Key, Settings } from "lucide-react"
import React, { useEffect } from "react"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { useNavigate, useParams } from "react-router-dom"
import { Button } from "@/components/atoms"
import ConnectionTest from "@/components/ConnectionTest"
import TextField from "@/components/input/TextField.rhf"
import { ApiStatusHandler } from "@/components/organisms"
import SinglePageLayout from "@/components/SinglePageLayout"
import useMongoServersApi, { keepsStoredMongoSecret, MongoServer, MongoServerDTO, MongoServerProvider, SECRET_PLACEHOLDER } from "@/hooks/apiClients/useMongoServersApi"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import ProvisionedDatabasesSection from "./partials/ProvisionedDatabasesSection"

/** I campi che decidono dove va una credenziale salvata */
const TARGET_FIELDS: string[] = [
    "provider",
    "connection.clientId",
    "connection.groupId",
    "connection.clusterName",
    "connection.tenantId",
    "connection.subscriptionId",
    "connection.resourceGroup",
    "connection.accountName"
]

/** Il progetto Atlas: l'id di 24 caratteri esadecimali che Atlas mostra nelle impostazioni del progetto */
const ATLAS_GROUP_ID = /^[a-f0-9]{24}$/i

/** Tenant, applicazione e sottoscrizione Azure: GUID, come li mostra il portale */
const AZURE_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Il nome di un account Cosmos DB: da 3 a 50 minuscole, cifre e trattini */
const COSMOS_ACCOUNT_NAME = /^(?=.{3,50}$)[a-z0-9]+(-[a-z0-9]+)*$/

interface MongoServerFormProps {
    initialData?: MongoServer
    id?: string
    onDone: () => void
}

const MongoServerForm: React.FC<MongoServerFormProps> = ({ initialData, id, onDone }) => {
    const { t } = useTranslation()
    const mongoServersApi = useMongoServersApi()
    const notifications = useToastNotificationStore()

    const form = useForm<MongoServerDTO>({
        defaultValues: initialData ?? { provider: MongoServerProvider.MONGODB, connection: {} }
    })

    const provider = form.watch("provider")

    // Un segreto salvato vale solo per il provider e il progetto/cluster con cui e' stato salvato (il backend lo
    // rifiuta altrove): cambiandoli il campo si svuota e chiede di riscriverlo
    useEffect(() => {
        if (!initialData) return
        const subscription = form.watch((_values, { name }) => {
            if (!name || !TARGET_FIELDS.includes(name) || keepsStoredMongoSecret(initialData, form.getValues())) return
            for (const key of ["connection.connectionString", "connection.clientSecret"] as const) {
                if (form.getValues(key) === SECRET_PLACEHOLDER) form.setValue(key, "")
            }
        })
        return () => subscription.unsubscribe()
    }, [initialData, form])

    // Solo i campi del provider scelto: quelli dell'altro non devono arrivare al backend
    const toDTO = (data: MongoServerDTO): MongoServerDTO => {
        const { connectionString, clientId, clientSecret, groupId, clusterName, tenantId, subscriptionId, resourceGroup, accountName } = data.connection
        const connections = {
            [MongoServerProvider.MONGODB]: { connectionString },
            [MongoServerProvider.ATLAS]: { clientId, clientSecret, groupId, clusterName },
            [MongoServerProvider.COSMOS_MONGO_RU]: { tenantId, clientId, clientSecret, subscriptionId, resourceGroup, accountName }
        }
        return { name: data.name, provider: data.provider, connection: connections[data.provider] }
    }

    const handleTest = async () => {
        if (!(await form.trigger(["provider", "connection"]))) return undefined
        return mongoServersApi.test(toDTO(form.getValues()), id)
    }

    const onSubmit = async (data: MongoServerDTO) => {
        if (id) {
            await mongoServersApi.update(id, toDTO(data))
            notifications.showSuccessNotification({ message: t("mongoServers.updateSuccess") })
        } else {
            await mongoServersApi.create(toDTO(data))
            notifications.showSuccessNotification({ message: t("mongoServers.createSuccess") })
        }
        onDone()
    }

    const providers = Object.values(MongoServerProvider).map(value => ({ value, label: t(`mongoServers.providers.${value}`) }))

    const required = { required: t("validation.required") }

    return (
        <FormProvider {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                <Card>
                    <CardHeader>
                        <div className="flex items-center gap-2">
                            <Settings className="h-5 w-5 text-muted-foreground" />
                            <CardTitle>{t("mongoServers.basicInformation")}</CardTitle>
                        </div>
                        <CardDescription>{t("mongoServers.basicInformationDescription")}</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <TextField name="name" dataTestId="mongo-server-name" label={t("mongoServers.name")} placeholder={t("mongoServers.namePlaceholder")} rules={required} />
                            <SelectField name="provider" label={t("mongoServers.provider")} options={providers} rules={required} />
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <div className="flex items-center gap-2">
                            <Key className="h-5 w-5 text-muted-foreground" />
                            <CardTitle>{t("mongoServers.connection")}</CardTitle>
                        </div>
                        <CardDescription>{t(`mongoServers.connectionDescriptions.${provider}`)}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {provider === MongoServerProvider.MONGODB && (
                            // Non e' un login: i password manager non devono riempirlo con le credenziali della console
                            <TextField
                                name="connection.connectionString"
                                dataTestId="mongo-server-connection-string"
                                type="password"
                                autoComplete="new-password"
                                label={t("mongoServers.fields.connectionString")}
                                placeholder="mongodb://root:password@db-0:27017,db-1:27017/admin?replicaSet=rs0&authSource=admin"
                                description={t("mongoServers.fields.connectionStringHint")}
                                rules={required}
                            />
                        )}

                        {provider === MongoServerProvider.ATLAS && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <TextField name="connection.clientId" dataTestId="mongo-server-client-id" label={t("mongoServers.fields.clientId")} autoComplete="off" rules={required} />
                                <TextField
                                    name="connection.clientSecret"
                                    dataTestId="mongo-server-client-secret"
                                    type="password"
                                    autoComplete="new-password"
                                    label={t("mongoServers.fields.clientSecret")}
                                    rules={required}
                                />
                                <TextField
                                    name="connection.groupId"
                                    dataTestId="mongo-server-group-id"
                                    label={t("mongoServers.fields.groupId")}
                                    description={t("mongoServers.fields.groupIdHint")}
                                    rules={{ ...required, pattern: { value: ATLAS_GROUP_ID, message: t("mongoServers.fields.groupIdInvalid") } }}
                                />
                                <TextField name="connection.clusterName" dataTestId="mongo-server-cluster-name" label={t("mongoServers.fields.clusterName")} placeholder="Cluster0" rules={required} />
                            </div>
                        )}

                        {provider === MongoServerProvider.COSMOS_MONGO_RU && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <TextField
                                    name="connection.tenantId"
                                    dataTestId="mongo-server-tenant-id"
                                    label={t("mongoServers.fields.tenantId")}
                                    autoComplete="off"
                                    rules={{ ...required, pattern: { value: AZURE_GUID, message: t("mongoServers.fields.guidInvalid") } }}
                                />
                                <TextField
                                    name="connection.clientId"
                                    dataTestId="mongo-server-client-id"
                                    label={t("mongoServers.fields.applicationId")}
                                    autoComplete="off"
                                    rules={{ ...required, pattern: { value: AZURE_GUID, message: t("mongoServers.fields.guidInvalid") } }}
                                />
                                <TextField
                                    name="connection.clientSecret"
                                    dataTestId="mongo-server-client-secret"
                                    type="password"
                                    autoComplete="new-password"
                                    label={t("mongoServers.fields.clientSecret")}
                                    rules={required}
                                />
                                <TextField
                                    name="connection.subscriptionId"
                                    dataTestId="mongo-server-subscription-id"
                                    label={t("mongoServers.fields.subscriptionId")}
                                    autoComplete="off"
                                    rules={{ ...required, pattern: { value: AZURE_GUID, message: t("mongoServers.fields.guidInvalid") } }}
                                />
                                <TextField
                                    name="connection.resourceGroup"
                                    dataTestId="mongo-server-resource-group"
                                    label={t("mongoServers.fields.resourceGroup")}
                                    autoComplete="off"
                                    rules={required}
                                />
                                <TextField
                                    name="connection.accountName"
                                    dataTestId="mongo-server-account-name"
                                    label={t("mongoServers.fields.accountName")}
                                    description={t("mongoServers.fields.accountNameHint")}
                                    autoComplete="off"
                                    rules={{ ...required, pattern: { value: COSMOS_ACCOUNT_NAME, message: t("mongoServers.fields.accountNameInvalid") } }}
                                />
                            </div>
                        )}

                        <ConnectionTest onTest={handleTest} dataTestId="mongo-server-test" />
                    </CardContent>
                </Card>

                <Alert>
                    <Key className="h-4 w-4" />
                    <AlertDescription>
                        <strong>{t("mongoServers.securityNotice")}</strong> {t("mongoServers.securityNoticeDescription")}
                    </AlertDescription>
                </Alert>

                <div className="flex justify-end space-x-4 pt-4">
                    <Button type="button" variant="secondary" onClick={onDone} dataTestId="mongo-server-cancel">
                        {t("common.cancel")}
                    </Button>
                    <Button type="submit" dataTestId="mongo-server-submit" disabled={form.formState.isSubmitting}>
                        {id ? t("common.update") : t("common.create")}
                    </Button>
                </div>
            </form>
        </FormProvider>
    )
}

/** Registra un server MongoDB, o lo modifica e ne gestisce i database creati: `/mongo-servers/new` e `/mongo-servers/:id` */
export const AddMongoServer = () => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { id } = useParams<{ id?: string }>()
    const mongoServersApi = useMongoServersApi()

    const serverQuery = useQuery({
        queryKey: ["mongo-server", id],
        queryFn: () => mongoServersApi.getSingle(id!),
        enabled: Boolean(id)
    })

    const handleDone = () => navigate("/mongo-servers")

    return (
        <SinglePageLayout title={id ? t("mongoServers.editServer") : t("mongoServers.newServer")} description={id ? t("mongoServers.editServerDescription") : t("mongoServers.newServerDescription")}>
            {id ? (
                <ApiStatusHandler queries={[serverQuery]}>
                    <div className="space-y-6">
                        {serverQuery.data && <ProvisionedDatabasesSection server={serverQuery.data} />}
                        <MongoServerForm initialData={serverQuery.data} id={id} onDone={handleDone} />
                    </div>
                </ApiStatusHandler>
            ) : (
                <MongoServerForm onDone={handleDone} />
            )}
        </SinglePageLayout>
    )
}

export default AddMongoServer
