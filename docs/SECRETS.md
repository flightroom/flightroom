# Encryption of the stored credentials

The console keeps credentials on behalf of a project: the keys of a bucket, an Azure connection
string, a Google service account file, the token of a code repository. Set `SECRETS_ENCRYPTION_KEY`
and they are encrypted in the database with AES-256-GCM, and no longer disclosed by the API.

```bash
# 32 bytes, base64 or hex
openssl rand -base64 32
```

```bash
SECRETS_ENCRYPTION_KEY=<the generated key>
```

Nothing else has to be done: at the next boot a migration rewrites, encrypted, whatever was written
before the key existed. It is a re-save per document and it skips what is already encrypted, so
running it again costs one empty query per collection.

## What this protects against, and what it does not

**Protected — whoever reads the database.** A dump, a backup, a hosted Mongo somebody else operates,
a support engineer with a shell on the replica: they see ciphertext, and the key is not in there
with it.

**Not protected — whoever controls the process.** The backend has to decrypt those values to talk to
S3 or to GitHub in a deploy nobody is watching, so the key is necessarily within reach of anybody
holding the environment of the application. Application level encryption cannot change that.

To narrow that second case you need the key to live somewhere the decrypt is a remote, authenticated
call — AWS KMS, Azure Key Vault, HashiCorp Vault. Whoever holds the credentials of the application
can still ask for a decrypt, but they cannot walk off with a dump and read it offline, and every
decrypt lands in an audit log you can revoke. The stored format carries a `v1` marker precisely so
that scheme can be introduced beside this one without rewriting a single value.

The alternative that does protect fully — a passphrase held by the user and never stored — is
incompatible with what this product does: without somebody there to unlock it, no pipeline could
upload a bundle.

## What is covered

| Where | Fields |
| --- | --- |
| `storages` | `secretAccessKey`, `accountKey`, `connectionString`, `clientSecret`, `jsonKey` |
| `databases` | `password`, `connectionString` |
| `coderepositories` | `accessToken`, `refreshToken` |
| `deployments` | the same storage fields, inside the snapshot a deployment freezes |
| `secrets` | the value of every key in every environment, of the secrets backends attach |
| `resources` | the fields of a resource the catalog marks as a credential (`secrets.value`, `secrets.overrides.value`): a database password or connection string, the key of an api, an ai or a storage, a client secret, an SMTP password, a variable a generic resource marks secret |
| `aimodels` | `config.apiKey`, `config.secretAccessKey`: the key of an AI provider and the secret access key of a Bedrock one |
| `projects` | `argoCd.token`, `argoCd.repositories.configuration.password`, `argoCd.repositories.applications.password`: the API token of Argo CD and the read-only repository credentials handed to it |

Deployments are in the list because a deployment copies the storages of its project, credentials
included, and the serve API reads the bucket keys from that copy. Encrypting the `storages`
collection alone would leave every key of every past deployment in the clear right next to it.

What is deliberately left readable is what names a resource rather than proving you may use it:
bucket, container, region, account name, tenant and client id. The list screen needs them to tell one
storage from another, and none of them is usable on its own.

**Global variables are not encrypted, and should not be mistaken for secrets.** The platform serves
them to every browser that loads the application, as `window.globalConfig`. Anything genuinely
secret does not belong in there in the first place.

## In the API

The credentials are no longer returned. Where one would be, the API sends `••••••••••••`, and a
field that comes back exactly as that placeholder is understood as "not retyped": the stored value is
kept. That is what lets the edit forms keep working — they submit every field, including the ones
they never received.

The consequence for the Azure and GitLab screens is that "test connection" on an existing connection
sends the id of the repository instead of a token, and the backend uses the one it has.

A resource follows the same rule, through its own serialisation (`toJSON` of the model, the only output of
a resource): every credential that is set comes out as the placeholder, one that is not set is left out, and
the pasted OpenAPI document of an `api` comes out only as `{ present, bytes }`. The fields that are no
credential (a host, a base URL, a model) are returned as they are.

Neither MCP clients nor the AI coding agent ever get a credential of a resource:

- The MCP tools (`resources_list`, `resource_get`...) answer with the masked resource. `resource_create` and
  `resource_update` refuse any credential field in their input: credentials are typed in the console only,
  as the values of a secret map are.
- The coding agent reads the resources attached to a backend with a projection that leaves out the
  credentials, the per-environment overrides and the pasted document. It is told the names of the
  variables (credentials marked `(secret)`), the name of the Kubernetes Secret carrying them
  (`<name>.resource`), and the shared value of a short list of fields that are no credential and say how to
  use the resource: an api's `baseUrl`, `specUrl`, `tokenUrl` and API key placement (`in`, `name`), an ai's
  `model`, an smtp's `host`, `port`, `security` and `from`, a sharepoint's `siteUrl` and `library`. Its prompt tells it to read every credential from
  those variables and never hardcode one.
- `read_api_spec`, the agent's tool for the document of an api, reads the pasted one from the database only
  when the agent asks, or fetches the `specUrl` from the backend: http or https only, no address that is
  not public (loopback, private, link local, unique local, CGNAT, cloud metadata, IPv4 inside IPv6),
  checked at connect time and on every redirect (3 at most), 10 seconds and 2 MiB at most, and no
  credential, cookie or header of the resource sent along. What it answers is framed as
  `<api_document resource="..." untrusted="true">`, and the prompt tells the agent that the document is
  data, never instructions, and that a client calls the `*_BASE_URL` variable of the resource, never the
  `servers` of the document.
- A job, or a domain plan, started by a member scoped to some domains tells the agent only the resources
  that member may read, as the console lists them.

With GitOps on, a deploy commits the Kubernetes Secret of every resource of the project
(`<environment>/resources/<name>.yaml`), as it does for every config map and secret, whether a backend
attaches it or not: a values file that a deploy of another domain left in place may still name
`<name>.resource`, and its pod would not start without it. The manifest goes only when the resource is
deleted, which is refused while a backend attaches it.

A stored credential is never sent somewhere new without being typed again. When an update changes where
a resource connects (a field the catalog marks as `connection`: a host, a port, a database name, a bucket
or container, an account name or region, an api's `baseUrl`, `specUrl` or `tokenUrl`, an ai's `baseUrl` or
`endpoint`, an auth0 `domain`) or its variant, every credential it would keep as stored (sent back as the
placeholder, or left out) is refused with `RESOURCE_SECRET_REENTRY_REQUIRED`, whose details name the
credentials to type again and the fields that changed:

- the variant, or the value of all of a connection field, changed: every credential kept, anywhere;
- only the override of a connection field in one environment changed: the value each credential takes in
  that environment, its own override there if it has one, its value of all otherwise.

The console says which credentials to type again as soon as such a field is edited. An MCP client cannot
type credentials, so its `resource_update` making such a change is refused with the same code and told to
make it from the console.

## Rotating or losing the key

There is no rotation procedure yet. What the format allows is introducing `v2` alongside `v1`, so
values keep being readable while new writes use the new scheme.

Losing the key means losing the credentials: a value encrypted with it cannot be read back, and the
application says so explicitly at the first read rather than behaving as if the storage were
misconfigured. Recovering means retyping the credentials in the console. **Back the key up
separately from the database** — a backup holding both protects nothing.

If the key is removed from the environment while encrypted values are in the database, the
application starts but fails on the first credential it touches. A key of the wrong length stops the
boot instead, with the command to generate a correct one.
