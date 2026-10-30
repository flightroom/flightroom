# Partitions of a shared database or storage

> **Status: design.** Nothing here is built yet. The phases at the end say in which order it lands.

An administrator connects one server once, such as a MongoDB cluster, a Cosmos DB account, an Azure SQL
server or a storage account. After that, the members of the project carve **partitions** out of it,
without asking anyone. A partition is a database or a container of its own, with a credential that
reaches nothing else. It becomes a **resource** that backends attach like any other.

Flightroom never creates a partition itself. It writes the Terraform of the partition into a repository
of the project. The pipeline of that repository applies it and hands the credential back to Flightroom.
That keeps the infrastructure declarative and reviewable, and keeps the administrative credentials of
the servers out of Flightroom.

## What a partition is, per source

| Source | Partition | Credential | Resource it becomes |
| --- | --- | --- | --- |
| MongoDB (self-hosted) | a database, with a user defined in it with `readWrite` + `dbAdmin` | `random_password` | `mongodb`, variant `connectionString` |
| Azure Cosmos DB for MongoDB (RU) | `azurerm_cosmosdb_mongo_database` + `azurerm_cosmosdb_mongo_user_definition` with `readWrite` + `dbAdmin` | `random_password` | `mongodb`, variant `connectionString` |
| Azure SQL Database | `azurerm_mssql_database` on the existing server + two contained users: one for the applications, one for the migrations | a `random_password` each | two `database` resources, variant `credentials`, engine `SQLSERVER` |
| Azure Storage account | `azurerm_storage_container` | a container SAS (`azurerm_storage_account_blob_container_sas`) | `storage`, variant `azureConnectionString` |

Why these credentials:

- **`readWrite` + `dbAdmin`, never `dbOwner`.** `dbAdmin` adds what `readWrite` lacks: validators and TTL
  changes (`collMod`), `compact`, the profiler. `dbOwner` adds `userAdmin` on top, and with it a partition
  user could create users and grant itself more.
- **Two users on SQL: the applications read and write, the migrations change the schema.**
  - The partition `orders` becomes two resources:
    - `orders`, for the applications: `db_datareader` + `db_datawriter`;
    - `orders-migrations`, for whoever aligns the schema: `db_ddladmin` + `db_datareader` +
      `db_datawriter`, because migrations often move data too.
  - Neither user gets `db_owner`: it manages users and permissions.
  - With fixed database roles, a table the migrations create is readable and writable by the
    applications at once, with no grant per table.
  - Whatever runs the migrations attaches `orders-migrations`: a job, the pipeline of the backend, or the
    backend itself when it migrates at startup. In that last case it attaches both resources, which get
    different variable prefixes.
- **One user on MongoDB and Cosmos DB.**
  - `readWrite` already creates and drops collections and indexes, so a migrations user apart from it
    would separate little.
  - Separating for real would take a custom data-only role for the applications. Their collections and
    indexes would then have to come from migrations, which breaks the backends that create them at
    startup (Mongoose `autoIndex` and `autoCreate`, both on by default).
- **Cosmos DB for MongoDB needs RU with role-based access control.** The account needs the
  `EnableMongoRoleBasedAccessControl` capability. Without it, the only credentials are the account keys,
  and they open every database. vCore (Azure DocumentDB) is out of scope: its secondary users have
  cluster-wide roles only, so they cannot be confined to one database.
- **A SAS for storage.** It is simpler to grant than an Entra ID app per container. The cost: it cannot
  be revoked on its own, only by rotating the account key it is signed with. It also expires, so
  Flightroom commits a new expiry before the old one is reached (see Rotation).

## The flow

1. A member asks for a partition named `orders` on a source.
2. Flightroom commits `partition-<source>-orders.tf` to the Terraform repository. It also creates the
   resources of the partition **pending**: `orders`, plus `orders-migrations` on SQL. In each one every
   field is set except the credential, which is empty. A required secret may be empty already today.
3. The pipeline of the repository runs `terraform apply`.
4. The pipeline reads the partition outputs (`terraform output -json`). It sends each one to
   `PUT /api/partitions/:resourceId/credentials`, signed with a Flightroom API key.
5. Flightroom writes the fields into the resource, encrypted like any credential, and the partition is
   **ready**. Every later apply sends them again, which is how a rotated credential gets there.

Terraform composes the connection string itself, from the address of the source and the user it has
just made. Flightroom knows the resource fields of each source, not the URL formats.

## The Terraform repository

It is a project setting, like the GitOps repository: a connection of the project and a repository,
either existing or created on the spot. Every source of the project commits to it.

Terraform reads only the files at the root of a module, not those in subfolders. The layout is
therefore flat, and the prefix of each file says who owns it:

```
backend.tf                           # state backend: scaffolded, filled in by the operator
versions.tf                          # required providers: scaffolded
source-<source>.tf                   # one per source: provider alias, variables of its admin credential, address
partition-<source>-<name>.tf         # one per partition: what it creates, and its output
azure-pipelines.yml                  # scaffolded pipeline, Azure DevOps
.github/workflows/partitions.yml     # scaffolded pipeline, GitHub Actions
```

Flightroom writes `source-*.tf` and `partition-*.tf`. It scaffolds the other files once, when the
repository is set, and never overwrites them afterwards: they belong to whoever operates the pipeline.

The contract between a partition file and Flightroom is one sensitive output per resource of the
partition. A SQL partition therefore has two outputs, one per user; a MongoDB partition has one, as in
this example, where the secret field is the connection string:

```hcl
output "flightroom_partition_<resourceId>" {
  sensitive = true
  value = {
    resourceId = "<resourceId>"
    fields     = { connectionString = "mongodb://orders_app:${random_password.orders.result}@..." }
  }
}
```

The pipeline sends `fields` as they are. Flightroom accepts only the secret fields of the variant
recorded on the partition, so a compromised pipeline can overwrite the credential of a partition. Where
the address is a separate plain field, as with SQL credentials, it cannot repoint it. Where the
variant is a connection string (MongoDB, or an Azure storage), the address travels in the secret and
the pipeline controls it as well.

### What the operator of the pipeline sets up

- The state backend, with the state kept private. **The state holds every generated password.**
- The secrets of the pipeline:
  - `FLIGHTROOM_URL` and `FLIGHTROOM_API_KEY`: a `MANAGER` API key of the project;
  - `ARM_*` for the `azurerm` provider;
  - for each source, the variables its `source-*.tf` declares (e.g. `TF_VAR_<source>_admin_password`).
- Network reach from the pipeline agent to each server, for the providers that connect to it:
  MongoDB and Azure SQL.

## Deleting a partition

It is refused while a backend attaches any resource of the partition, as for any resource. On SQL that
includes the migrations resource. Then the member chooses:

- **Keep the data.** Flightroom replaces the partition file with a `removed { lifecycle { destroy = false } }`
  block for the database or container (Terraform ≥ 1.7). The user, or the SAS, goes away; the data
  stays where it is, and Terraform no longer manages it.
- **Delete the data.** Flightroom deletes the file, and the apply destroys everything in it.
  MongoDB is the exception: Terraform manages its users, not its databases (they are created by the
  first write), so the data of a MongoDB partition is dropped by hand.

The resource is deleted when the commit is pushed. Its credential stops working once the apply has run.

## Rotation

- **Passwords.** Flightroom commits a new `keepers` value on the `random_password`, then the apply runs.
  The next callback brings the new connection string. The backends pick it up at their next rollout.
- **SAS.** The expiry is written into the file (one year by default). Flightroom shows how many days
  are left and commits a new start and expiry when asked.

## Who may do what

- **Connect a source**, or turn partitions on for it: a member of the project (not a viewer), as for
  databases today. An organization administrator may do it in any project.
- **Create and delete partitions:** owners and members of the project. Viewers see them.
- **Callback:** a `MANAGER` API key of the project.
- No quotas in the first version.

## Model

- `Resource.partition`: the source (kind and id), the name of the database or container, the user, its
  role (`app`, or `migrations` on SQL), a status of `pending` or `ready`, and when it became ready. The
  resources of one partition share the source and the name, which is how they are found together. Set only by Flightroom, never from a request.
  A resource with a partition keeps its variant and fields to itself. Its name, description, AI context
  and prefix remain editable, and it is deleted only through its partition.
- The sources gain what Terraform needs to find them in Azure: subscription, resource group, and the
  name of the server or account.
  - `DatabaseType` gains `MONGODB` and `COSMOSDB_MONGO`.
  - A Cosmos DB account needs no credential in Flightroom, since Flightroom never connects to it.
  - Azure SQL is an existing `SQLSERVER` database with its Azure coordinates set.
  - The storage is an existing Azure `Storage`, with the same coordinates.

## Phases

1. **Common base + MongoDB.** The Terraform repository setting and its scaffolding (pipelines included),
   `Resource.partition`, the callback, the partitions section on a database, and the MongoDB source.
2. **Cosmos DB for MongoDB and Azure Storage.**
3. **Azure SQL Database.**

Each phase ships with tests, the it/en translations and its own commit.

## To verify before building

- **MongoDB provider.** There is no official provider for the users of a self-hosted MongoDB. Pick a
  community one, check that it is maintained, and confirm how it defines a user in a database with
  roles. Phase 1 starts with this.
- **Built-in roles on Cosmos DB.** Check that `inherited_role_names` accepts the built-in `readWrite`
  and `dbAdmin`. The provider documentation only says the role must exist in the database; the
  built-in ones exist in every database.
- **Users on Azure SQL.** `azurerm` cannot create a contained user. The community `mssql` provider
  usually used for it may be archived: pick a maintained one, or fall back to a `sqlcmd` step.
- **Cost of Azure SQL.** Each Azure SQL database is billed on its own unless it sits in an elastic pool.
  Decide whether the source names an elastic pool, which would be the default, or a SKU.
- **Commits.** They go straight to the default branch, as GitOps commits do. A pull request per
  partition, for a review before the apply, is a possible option for later.
