import { Alert, AlertDescription, Card, CardContent, CardDescription, CardHeader, CardTitle, SelectField, SwitchField as Switch } from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { Key, Settings } from "lucide-react"
import React, { useEffect, useMemo, useRef } from "react"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { useNavigate, useParams } from "react-router-dom"
import { Button } from "@/components/atoms"
import ConnectionTest from "@/components/ConnectionTest"
import TextField from "@/components/input/TextField.rhf"
import { ApiStatusHandler } from "@/components/organisms"
import SinglePageLayout from "@/components/SinglePageLayout"
import useDatabaseApi, {
    AUTH_TYPES_OF,
    canProvision,
    Database,
    DatabaseAuthType,
    DatabaseDTO,
    DatabaseType,
    DEFAULT_DATABASE_PORT,
    keepsStoredSecret,
    SECRET_PLACEHOLDER
} from "@/hooks/apiClients/useDatabaseApi"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import ProvisionedDatabasesSection from "./partials/ProvisionedDatabasesSection"

/** I campi che decidono dove va una credenziale salvata */
const TARGET_FIELDS: string[] = [
    "type",
    "connection.authType",
    "connection.host",
    "connection.port",
    "connection.database",
    "connection.username",
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

/** I campi di ogni modo di connettersi: solo quelli del modo scelto arrivano al backend */
const CONNECTION_FIELDS: Record<DatabaseAuthType, string[]> = {
    credentials: ["host", "port", "database", "username", "password", "ssl"],
    connectionString: ["connectionString"],
    atlasServiceAccount: ["clientId", "clientSecret", "groupId", "clusterName"],
    azureServicePrincipal: ["tenantId", "clientId", "clientSecret", "subscriptionId", "resourceGroup", "accountName"]
}

const toDTO = (data: DatabaseDTO): DatabaseDTO => {
    const connection = data.connection as unknown as Record<string, unknown>
    const fields = CONNECTION_FIELDS[data.connection.authType] ?? []
    return {
        name: data.name,
        type: data.type,
        connection: Object.fromEntries([["authType", data.connection.authType], ...fields.map(field => [field, connection[field]])]) as DatabaseDTO["connection"]
    }
}

interface DatabaseFormProps {
    initialData?: Database
    id?: string
    onDone: () => void
}

const DatabaseForm: React.FC<DatabaseFormProps> = ({ initialData, id, onDone }) => {
    const { t } = useTranslation()
    const databaseApi = useDatabaseApi()
    const notifications = useToastNotificationStore()

    const form = useForm<DatabaseDTO>({
        defaultValues: initialData ?? {
            type: DatabaseType.POSTGRESQL,
            connection: { authType: "credentials", port: DEFAULT_DATABASE_PORT[DatabaseType.POSTGRESQL], ssl: true } as DatabaseDTO["connection"]
        }
    })

    const type = form.watch("type")
    const authType = form.watch("connection.authType")
    const authTypes = AUTH_TYPES_OF(type)

    // Un motore che non si raggiunge nel modo scelto passa al primo dei suoi: MongoDB non ha credenziali, SQL non ha Atlas
    useEffect(() => {
        if (!AUTH_TYPES_OF(type).includes(form.getValues("connection.authType"))) form.setValue("connection.authType", AUTH_TYPES_OF(type)[0])
    }, [type, form])

    // La porta segue il motore finche' e' quella predefinita del motore precedente, o e' vuota perche' si arriva
    // dalla stringa di connessione: una porta scelta a mano resta
    const previousType = useRef(type)
    useEffect(() => {
        const port = form.getValues("connection.port" as never) as unknown as number | undefined
        if (authType === "credentials" && (!port || Number(port) === DEFAULT_DATABASE_PORT[previousType.current])) {
            form.setValue("connection.port" as never, DEFAULT_DATABASE_PORT[type] as never)
        }
        previousType.current = type
    }, [type, authType, form])

    // Una credenziale salvata vale solo per il motore e l'indirizzo con cui e' stata salvata (il backend la
    // rifiuta altrove): cambiandoli il campo si svuota e chiede di riscriverla
    useEffect(() => {
        if (!initialData) return
        const subscription = form.watch((_values, { name }) => {
            if (!name || !TARGET_FIELDS.includes(name) || keepsStoredSecret(initialData, form.getValues())) return
            for (const key of ["connection.password", "connection.connectionString", "connection.clientSecret"] as const) {
                if ((form.getValues(key as never) as unknown) === SECRET_PLACEHOLDER) form.setValue(key as never, "" as never)
            }
        })
        return () => subscription.unsubscribe()
    }, [initialData, form])

    const handleTest = async () => {
        if (!(await form.trigger(["type", "connection"]))) return undefined
        return databaseApi.test(toDTO(form.getValues()), id)
    }

    const onSubmit = async (data: DatabaseDTO) => {
        if (id) {
            await databaseApi.update(id, toDTO(data))
            notifications.showSuccessNotification({ message: t("database.updateSuccess") })
        } else {
            await databaseApi.create(toDTO(data))
            notifications.showSuccessNotification({ message: t("database.createSuccess") })
        }
        onDone()
    }

    const databaseTypes = useMemo(() => Object.values(DatabaseType).map(value => ({ value, label: t(`database.types.${value}`) })), [t])
    const authTypeOptions = authTypes.map(value => ({ value, label: t(`database.authTypes.${value}`) }))

    const required = { required: t("validation.required") }
    const guid = { ...required, pattern: { value: AZURE_GUID, message: t("database.fields.guidInvalid") } }
    const isMongo = type === DatabaseType.MONGODB

    return (
        <FormProvider {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                <Card>
                    <CardHeader>
                        <div className="flex items-center gap-2">
                            <Settings className="h-5 w-5 text-muted-foreground" />
                            <CardTitle>{t("database.basicInformation")}</CardTitle>
                        </div>
                        <CardDescription>{t("database.basicInformationDescription")}</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <TextField name="name" dataTestId="database-name" label={t("database.name")} placeholder={t("database.namePlaceholder")} rules={required} />
                            <SelectField name="type" label={t("database.type")} options={databaseTypes} rules={required} />
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <div className="flex items-center gap-2">
                            <Key className="h-5 w-5 text-muted-foreground" />
                            <CardTitle>{t("database.connection")}</CardTitle>
                        </div>
                        <CardDescription>{isMongo ? t(`database.mongoConnectionDescriptions.${authType}`) : t("database.connectionDescription")}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <SelectField name="connection.authType" label={t("database.fields.authType")} options={authTypeOptions} rules={required} />

                        {authType === "credentials" && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <TextField name="connection.host" dataTestId="database-host" label={t("database.fields.host")} placeholder="db.example.com" rules={required} />
                                <TextField
                                    name="connection.port"
                                    dataTestId="database-port"
                                    type="number"
                                    label={t("database.fields.port")}
                                    rules={{ ...required, min: { value: 1, message: t("database.portInvalid") }, max: { value: 65535, message: t("database.portInvalid") } }}
                                />
                                <TextField name="connection.database" dataTestId="database-database" label={t("database.fields.database")} rules={required} />
                                <TextField name="connection.username" dataTestId="database-username" label={t("database.fields.username")} autoComplete="off" rules={required} />
                                {/* Non e' un login: i password manager non devono riempirli con le credenziali della console */}
                                <TextField
                                    name="connection.password"
                                    dataTestId="database-password"
                                    type="password"
                                    autoComplete="new-password"
                                    label={t("database.fields.password")}
                                    rules={required}
                                />
                                <div className="flex items-end pb-2">
                                    <Switch name="connection.ssl" label={t("database.fields.ssl")} />
                                </div>
                            </div>
                        )}

                        {authType === "connectionString" && (
                            <TextField
                                name="connection.connectionString"
                                dataTestId="database-connection-string"
                                type="password"
                                autoComplete="new-password"
                                label={t("database.fields.connectionString")}
                                placeholder={t(`database.connectionStringPlaceholders.${type}`)}
                                description={isMongo ? t("database.fields.mongoConnectionStringHint") : undefined}
                                rules={required}
                            />
                        )}

                        {authType === "atlasServiceAccount" && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <TextField name="connection.clientId" dataTestId="database-client-id" label={t("database.fields.clientId")} autoComplete="off" rules={required} />
                                <TextField
                                    name="connection.clientSecret"
                                    dataTestId="database-client-secret"
                                    type="password"
                                    autoComplete="new-password"
                                    label={t("database.fields.clientSecret")}
                                    rules={required}
                                />
                                <TextField
                                    name="connection.groupId"
                                    dataTestId="database-group-id"
                                    label={t("database.fields.groupId")}
                                    description={t("database.fields.groupIdHint")}
                                    rules={{ ...required, pattern: { value: ATLAS_GROUP_ID, message: t("database.fields.groupIdInvalid") } }}
                                />
                                <TextField name="connection.clusterName" dataTestId="database-cluster-name" label={t("database.fields.clusterName")} placeholder="Cluster0" rules={required} />
                            </div>
                        )}

                        {authType === "azureServicePrincipal" && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <TextField name="connection.tenantId" dataTestId="database-tenant-id" label={t("database.fields.tenantId")} autoComplete="off" rules={guid} />
                                <TextField name="connection.clientId" dataTestId="database-client-id" label={t("database.fields.applicationId")} autoComplete="off" rules={guid} />
                                <TextField
                                    name="connection.clientSecret"
                                    dataTestId="database-client-secret"
                                    type="password"
                                    autoComplete="new-password"
                                    label={t("database.fields.clientSecret")}
                                    rules={required}
                                />
                                <TextField name="connection.subscriptionId" dataTestId="database-subscription-id" label={t("database.fields.subscriptionId")} autoComplete="off" rules={guid} />
                                <TextField name="connection.resourceGroup" dataTestId="database-resource-group" label={t("database.fields.resourceGroup")} autoComplete="off" rules={required} />
                                <TextField
                                    name="connection.accountName"
                                    dataTestId="database-account-name"
                                    label={t("database.fields.accountName")}
                                    description={t("database.fields.accountNameHint")}
                                    autoComplete="off"
                                    rules={{ ...required, pattern: { value: COSMOS_ACCOUNT_NAME, message: t("database.fields.accountNameInvalid") } }}
                                />
                            </div>
                        )}

                        <ConnectionTest onTest={handleTest} dataTestId="database-test" />
                    </CardContent>
                </Card>

                <Alert>
                    <Key className="h-4 w-4" />
                    <AlertDescription>
                        <strong>{t("database.securityNotice")}</strong> {isMongo ? t("database.mongoSecurityNoticeDescription") : t("database.securityNoticeDescription")}
                    </AlertDescription>
                </Alert>

                <div className="flex justify-end space-x-4 pt-4">
                    <Button type="button" variant="secondary" onClick={onDone} dataTestId="database-cancel">
                        {t("common.cancel")}
                    </Button>
                    <Button type="submit" dataTestId="database-submit" disabled={form.formState.isSubmitting}>
                        {id ? t("common.update") : t("common.create")}
                    </Button>
                </div>
            </form>
        </FormProvider>
    )
}

/** Collega un database, o lo modifica e, se ne puo' creare (MongoDB), gestisce i database creati su di lui */
export const AddDatabase = () => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { id } = useParams<{ id?: string }>()
    const databaseApi = useDatabaseApi()

    const databaseQuery = useQuery({
        queryKey: ["database", id],
        queryFn: () => databaseApi.getSingle(id!),
        enabled: Boolean(id)
    })

    const handleDone = () => navigate("/databases")

    return (
        <SinglePageLayout title={id ? t("database.editDatabase") : t("database.newDatabase")} description={id ? t("database.editDatabaseDescription") : t("database.newDatabaseDescription")}>
            {id ? (
                <ApiStatusHandler queries={[databaseQuery]}>
                    <div className="space-y-6">
                        {databaseQuery.data && canProvision(databaseQuery.data) && <ProvisionedDatabasesSection server={databaseQuery.data} />}
                        <DatabaseForm initialData={databaseQuery.data} id={id} onDone={handleDone} />
                    </div>
                </ApiStatusHandler>
            ) : (
                <DatabaseForm onDone={handleDone} />
            )}
        </SinglePageLayout>
    )
}

export default AddDatabase
