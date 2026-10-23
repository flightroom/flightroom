# Remote MCP server

The console can expose its features to AI clients (Claude, Claude Code, Cursor, VS Code and any other
client speaking the [Model Context Protocol](https://modelcontextprotocol.io)) through a remote MCP
server. The client connects with OAuth: the user signs in to the console as usual, picks **one or
more projects** (grouped by organization) and whether the client may change things, and the client
only ever acts inside the projects picked.

It is off by default.

## Turning it on

| Variable             | Default                     | What it does                                                                              |
| -------------------- | --------------------------- | ----------------------------------------------------------------------------------------- |
| `MCP_ENABLED`        | `false`                     | Mounts the MCP server, the OAuth endpoints and the discovery documents.                    |
| `FRONTEND_URL`       | _(required)_                | Public URL of the console: the consent page lives there.                                   |
| `JWT_SECRET`         | _(required)_                | Your own secret, at least 32 bytes (`openssl rand -hex 32`). With MCP on, the backend refuses to start on a missing, placeholder or short one. |
| `MCP_DCR_ENABLED`    | `true`                      | Dynamic client registration (RFC 7591), what most clients use today.                       |
| `MCP_API_KEY_ENABLED` | `true`                     | Lets clients that cannot do OAuth use a project API key instead (see below).               |
| `MCP_RATE_LIMIT_MAX` | `120`                       | MCP requests per minute for each grant or API key, on top of `RATE_LIMIT_MAX` per IP.      |
| `MCP_CIMD_ENABLED`   | `true`                      | Client ID metadata documents: the `client_id` is an https URL describing the client.       |
| `CIMD_ALLOWED_HOSTS` | _(any)_                     | Comma separated hosts allowed to publish client metadata documents. Listed hosts show as verified on the consent page; with no list every CIMD client is unverified. |
| `OAUTH_ISSUER_URL`   | `BACKEND_URL`               | Only when the issuer cannot be derived (default: `FRONTEND_URL` + `/api`).                 |
| `MCP_RESOURCE_URL`   | issuer + `/mcp`             | Only when the MCP endpoint is published somewhere else.                                    |
| `TRUST_PROXY`        | `127.0.0.1` in the images   | Proxies whose `X-Forwarded-For` is trusted, so per-IP rate limits see the real client.     |

The URL to give to MCP clients is shown in the console (Settings → MCP clients). With the default
layout it is `https://<your console>/api/mcp`.

## What the client can do

Two scopes, chosen on the consent page:

- `mfe:read` — read the project: frontends, backends, functional domains, environments,
  deployments, canary users, global variables, build status, storages, resources and repository
  connections (credentials masked), dependency and integration plans.
- `mfe:write` — everything the console does inside a project, **deploy and rollback included**:
  create and edit frontends, backends, domains and environments, trigger builds, import
  repositories, change global variables, apply dependency alignments and integrations. It also
  allows **creating projects** (see below), which the consent page says next to "Allow changes".

The role caps each project separately. `mfe:write` can be granted when at least one picked project
lets the user write; on a project where the user is a **VIEWER** every write tool is refused with an
explicit error, whatever the grant says. Roles are read again on every request, so demoting a member
takes write access away from their clients immediately.

The console's own assistant runs these same tools in process, for the signed-in user and on the
project open in the console (see [AI providers](AI-PROVIDERS.md#the-console-assistant)). A tool
defined with `consoleOnly: true` sits in the same registry (`MCP_TOOLS`) but is never registered on
the MCP server: only the assistant offers it. A tool may also define `presentResult` to keep part of
its result (a new API key, say) away from the model while the user still sees it; MCP clients always
get the whole result. The annotations MCP clients see (`destructiveHint`...) stay truthful: whether
the assistant asks the user before running a tool is `requiresConfirmation`, which defaults to
`destructiveHint` and is set to true on writes that hand out access or cannot be undone (invitations,
API key creation, discarding an AI change, canary users).

## Project context

Every project, functional domain, frontend and backend can carry a **context**: free markdown
the team writes for AI agents (domain, conventions, rules). The project one is edited in Settings →
Project AI context, the domain one in the domain form, the frontend and backend ones in their
"AI context" tab. Each is limited to 20,000 characters.

An agent always gets the contexts of what it works on, the project one included:

| Working on | Contexts returned |
| --- | --- |
| a frontend (frontend) | the frontend, its domain, the project |
| a backend | the backend, its domain, the project |
| a domain | the domain, each of its frontends and backends, the project |

- `context_get` (`mfe:read`) takes at most one of `frontendId`, `backendId`, `domainId` and
  returns the contexts above. Without ids it returns every context of the project. The server
  instructions ask clients to call it before working on a project.
- `frontend_get`, `backend_get` and `domain_get` return the same contexts in `aiContext`, so an
  agent that reads what it works on gets its notes without a second call.
- `project_update`, `domain_create`/`domain_update`, `frontend_update` and `backend_update`
  (`mfe:write`) change them; `null` removes the project and the domain context.
- The console assistant reads the same notes through the same tools. The console's AI change jobs
  put the project context, the domain context (of the job's domain, or of the domains its
  frontends and backends are in) and the context of each repository in the agent's prompt.

### Design system

The **design system** the frontends are built with (the npm package, a version range, the
documentation URL, the `.npmrc` the package installs with and notes for agents) is set at three
levels, the most specific winning:

1. **Organization** (Organization settings → Design system): the one of every project that does not
   set its own. Only its owners and admins change it.
2. **Project** (Settings → Design system, "Use a project-specific design system"): replaces the
   organization's for its frontends; turned off, the project inherits it again.
3. **Frontend** (its "AI context" tab, "Use its own design system"): replaces the one the project
   resolves to.

`project.designSystem` in `context_get` is the one of the project, its own or else the
organization's, and `project.designSystemSource` says which (`project` or `organization`). With a
`frontendId`, `designSystem` is the one that frontend builds with and `designSystemSource` the level
it comes from (`frontend`, `project` or `organization`). The AI change jobs put the frontend's in the
prompt of each frontend repository, telling the agent to build the UI with that package and no other
UI library; the domain planner is told the project's by name, to pick a frontend template that can
use it. `project_update`, `frontend_create` and `frontend_update` set it, replaced as a whole; `null`
goes back to the level above. The organization's is set from the console, and by its assistant
through `organization_update`, which MCP clients do not get.

The `.npmrc` is stored as pasted and the console shows it whole, but every response that reaches an
AI (MCP tools, the assistant, the agent prompt) masks its credentials: the value of `_authToken`,
`_auth`, `_password`, `username`, `email`, `certfile`, `keyfile` and similar keys, scoped or not,
becomes `***`. Registry and scope lines (`@acme:registry=...`) stay readable, as does a value that
only names an environment variable (`${NPM_TOKEN}`).

The one exception is `design_system_npmrc_get` (`mfe:write`), for a user who wants to install the
package on their own machine. It returns the whole `.npmrc`, credentials included, of the design
system a frontend builds with (`frontendId`), or of the project's without one, along with
`packageName` and `source`. A VIEWER cannot call it, even with `mfe:write`. It is not marked
read-only, so the client asks the user before running it. Every call goes into the audit log like
any other tool call. The console assistant does not have it, so the console's model never reads the
credentials. A design system without an `.npmrc`, or no design system at all, is refused with
`DESIGN_SYSTEM_NPMRC_MISSING`.

## Domains and backends

A project can group its frontends and backends in **functional domains**. Membership
lives on the member: each frontend or backend has an optional `domainId`, so it is in one domain
at most.

- `domains_list` (`mfe:read`) returns the domains with how many frontends and backends each one
  groups; `domain_get` adds the id, name and slug of every member.
- `domain_create` and `domain_update` (`mfe:write`) set the name and the description; the slug is
  derived from the name when left out and fixed after creation. `domain_delete` is destructive: the
  members are kept and end up in no domain.
- `domain_trigger_build` (`mfe:write`) releases a whole domain: it tags the repository of every
  frontend and backend in it with the same version, on the same branch (`main` when left out),
  and each tag starts the pipeline of its repository. A repository linked to two members is tagged
  once. Every repository is checked before any tag is made (the connection belongs to the project,
  the domain scope, the repository and the branch exist, the tag does not): when one fails nothing is
  tagged and the error lists each failure. A VIEWER of the project cannot run it, nor the build of a
  single frontend or backend. The result tells, per repository, whether it was tagged. The console offers
  the same as "Build domain" on the domain page, and the REST API as `POST /api/domains/:id/build`.
- `domain_links_list` (`mfe:read`) returns the relations the team drew by hand between two domains,
  each from `sourceDomainId` to `targetDomainId` with an optional label; `domain_link_create` and
  `domain_link_delete` (`mfe:write`, the delete destructive) draw and remove them. A relation goes one
  way, and deleting a domain deletes its relations.
- `domain_deployments_get` (`mfe:read`) tells, for one domain or for the whole project, which version of
  each frontend and backend runs in each environment: the frontend from the active deployment
  snapshot, the backend from the versions the customer's deploy pipeline reported.
- `backends_list`, `backend_get` (`mfe:read`) and `backend_create`, `backend_update`, `backend_delete`
  (`mfe:write`, the delete destructive) manage the backends: name, description, domain,
  context, port, probe and API documentation paths, image repository, the environment variables the
  image reads (names only, never values) and a link to a repository that already exists. The slug is
  fixed after creation. The version comes from the CI, never from a tool.
- `frontend_scaffold` and `backend_scaffold` (`mfe:write`) create the frontend or the backend
  together with a new repository at the provider, from a marketplace template (`templates_list`) and
  through a repository connection of the project (`code_repositories_list`), with its CI pipeline and,
  on GitHub, the deploy secret. Neither the connection's credentials nor that secret are ever part of
  the input or of the result, and the console assistant asks the user before running them. Creating a
  domain creates no repository: scaffold its members with these tools and its `domainId`.
- `frontend_create`, `frontend_update`, `backend_create` and `backend_update` take an optional
  `domainId`; `null` takes the item out of its domain. A domain of another project is refused before
  anything is written.
- A backend and a frontend of kind `DOCKER` (served by its own Docker container) take an optional
  `exposurePath`, the same on the host of every environment; `null` means it is not exposed.
- `frontends_list` and `backends_list` take an optional `domainId` filter: a domain id, or `none`
  for the items in no domain.

## Resources

A **resource** is a package of environment variables of a catalog type (`database`, `mongodb`, `bigquery`, `storage`,
`redis`, `serviceAccount`, `auth0`, `api`, `ai`, `smtp`, `generic`) that backends attach by id
(`resourceIds`); a frontend never does. A `generic` resource (variant `custom`) is for anything the catalog
lacks: it defines its own variables in `customFields` (`[{ name, secret }]`, at most 100, each set as
`<prefix>_<name>`, all optional), whose values go in `fields` by name like any other. Each one becomes a Kubernetes Secret named `<name>.resource` at the next GitOps deploy.

- `resource_types_list` (`mfe:read`) returns the catalog: each type with its variants and their fields
  (variable suffix, whether it is a credential, required, how it is typed).
- `resources_list` and `resource_get` (`mfe:read`) return the resources with their fields, the value in
  every environment and the overrides, and `env`, the variables each one sets. Credentials come back
  masked, as `secret_get` masks values; the pasted OpenAPI document of an `api` never comes back, only
  `apiSpec: { present, bytes }`.
- `resource_create` and `resource_update` (`mfe:write`) write the name, type (fixed once created),
  variant, description, `envPrefix`, the `customFields` of a `generic` (refused on any other type; renaming,
  removing or turning one secret or plain drops its values), the fields that are no credential and the
  pasted `apiSpec`. An update
  merges by field: a field left out keeps its value, one sent as `null` is unset. **A credential field is
  refused** ("Secret fields of a resource are set from the console"): it is typed in the console only. So is
  an update changing the variant or where a resource with stored credentials connects (its host, base URL...):
  those credentials must be typed again (`RESOURCE_SECRET_REENTRY_REQUIRED`, see
  [SECRETS.md](./SECRETS.md)), which only the console does. `resource_delete` is destructive
  and refused while a backend attaches the resource.
- `backend_create` and `backend_update` take `resourceIds` (at most 50, replaced as a whole); a variable
  of a resource clashing with one of the config maps, secrets or other resources of the backend is refused.
- `domain_get` adds `resources`: the resources the backends of the domain attach, each with its `env`
  keys and `usedBy`, the slugs of those backends (left out when none attaches one).

## Several projects in one connection

- `projects_list` returns the shared projects with their organization and the user's role;
  `organizations_list` and `organization_get` describe the organizations that contain them (names
  and shared projects only: never members, never projects that were not shared).
- Every other tool takes an optional `projectId`. With a single shared project it can be left out;
  with more than one it is required, and a call without it answers with a message pointing at
  `projects_list`. Every id passed to a tool (frontend, environment, deployment, ...) is checked
  against the project the call picked.
- A project the user loses access to drops out of the connection on the next request; when none is
  left, the grant is revoked.
- Grants created before multi-project consent (a single project) keep working unchanged.

## Creating a project

`project_create` (`mfe:write`) creates a project in one of the organizations `organizations_list`
returns, that is an organization that already contains a shared project. The user has to administer
it (owner or admin), as in the console. The user becomes the project's owner and the project is
added to the grant at once, so the client can go on with `projectId` and set up environments and
frontends, even with an access token minted before the project existed. An organization the
user administers but shared nothing from stays out of reach, and a project API key cannot create
projects: there is no user to own them.

- Only grants approved since the consent page mentions project creation can use it. A client
  connected earlier gets an error asking to reconnect: its user never agreed to it.
- One connection creates at most 10 projects, so an agent stuck in a loop cannot fill a tenant.
- Every creation is logged with the `mcp_grant_project_created` audit tag (grant, client,
  organization, project).

Left out on purpose: API keys, creating or editing
storages and repository connections and the credentials of a resource (their input is a secret), deleting projects, organizations,
members, invitations, the user profile, bundle upload and the canvas layout.

## Fallback: a project API key

OAuth is the way to connect: the user consents in the browser and can revoke the client from the
console. For a client that cannot do OAuth (a script, a CI job, a client without browser login),
`/mcp` also accepts a **project API key** (Settings → API keys), either as
`Authorization: Bearer <key>` or as an `api-key: <key>` header.

- The key reaches its own project and nothing else (`projectId` can always be left out);
  organization-level operations are denied.
- A `VIEWER` key gets `mfe:read`, a `MANAGER` key gets `mfe:read` and `mfe:write` (deploy and
  rollback included), except `project_create`. The same tools stay excluded as for OAuth.
- Revoked and expired keys are refused, exactly as on the API key routes.
- A valid key is remembered for up to 60 seconds (in Redis when configured, in memory otherwise),
  so the bcrypt check is not repeated on every call. Revoking or deleting the key in the console
  drops it at once; a key that simply expires stops working at its expiry.
- Whoever holds the key acts as the project, not as a person: there is no user to revoke it from
  and nothing on the consent page. Prefer OAuth whenever the client supports it, and set
  `MCP_API_KEY_ENABLED=false` to turn the fallback off.

The audit log line of every tool call names either `grantId` (OAuth) or `apiKeyId` (API key).

Client configuration, with `https://<your console>/api/mcp` as the URL:

```bash
# Claude Code
claude mcp add --transport http flightroom https://<your console>/api/mcp \
  --header "Authorization: Bearer <api key>"
```

```json
// Gemini CLI: ~/.gemini/settings.json
{
  "mcpServers": {
    "flightroom": {
      "httpUrl": "https://<your console>/api/mcp",
      "headers": { "Authorization": "Bearer <api key>" }
    }
  }
}
```

```json
// Cursor: ~/.cursor/mcp.json (or .cursor/mcp.json in the project)
{
  "mcpServers": {
    "flightroom": {
      "url": "https://<your console>/api/mcp",
      "headers": { "Authorization": "Bearer ${env:FLIGHTROOM_API_KEY}" }
    }
  }
}
```

## Revoking access

Settings → MCP clients lists the clients that include the current project, with the other shared
projects the viewer can see. A project OWNER (or an organization admin) sees and can revoke everyone's
grants that include their project; other members see and revoke their own. A revocation removes the
whole grant, all its projects, and takes effect on the client's next request. A grant also ends by
itself when the user loses access to all its projects, after 30 days without use, and in any case
after 90 days.

## How it works

- **Discovery.** `POST /api/mcp` without a token answers `401` with
  `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/api/mcp"`.
  That document (RFC 9728) names the authorization server, whose metadata (RFC 8414) is at
  `/.well-known/oauth-authorization-server/api` (also served as `openid-configuration`).
- **Authorization.** OAuth 2.1 authorization code with PKCE (S256 only), public clients, RFC 8707
  resource indicators and the RFC 9207 `iss` parameter. `/oauth/authorize` parks the request for 10
  minutes and sends the browser to `/oauth/consent` in the console; the code it produces is
  single-use and lives 60 seconds.
- **Tokens.** Access tokens are JWTs (`typ: at+jwt`) valid 15 minutes, signed with a key derived from
  `JWT_SECRET` but distinct from the console's: a console session token is refused by `/mcp` and an
  MCP token cannot open a console session. Refresh tokens are opaque, rotate on every use, and a
  replayed one revokes the whole grant.
- **Transport.** Streamable HTTP, stateless: `POST` only, `GET`/`DELETE` answer `405`.

## What the consent page warns about

- **unverified** — the client's name is self-asserted: always for dynamically registered clients,
  and for metadata-document clients whose host is not in `CIMD_ALLOWED_HOSTS`. The page shows the
  `client_id` host, the only part of a metadata-document client that is actually proven.
- **redirect_host_mismatch** — the code would be sent to an https host other than the client's.
- **localhost** / **custom_scheme** — the code goes to a local application.

## Reverse proxy

The discovery documents live at the **origin root**, outside `/api`. The bundled nginx already
routes `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` and
`/.well-known/openid-configuration` to the backend with the path untouched, and serves `/api/mcp`
without buffering. If you put another proxy in front, do the same.

Rate limits are per client IP (client registration: 10 per hour; `/mcp` also has its own limit per
grant and per API key), so the backend must know which
proxies to believe in `X-Forwarded-For`. The images trust their own nginx (`TRUST_PROXY=127.0.0.1`).
Behind a Kubernetes ingress the request reaches that nginx from the ingress controller's pod, so add
that hop, or every client is seen with the controller's IP and shares one bucket:

```yaml
# helm values
env:
  TRUST_PROXY: "loopback,10.0.0.0/8"   # in-pod nginx + ingress pods in the pod CIDR
```

Trust only the hops you actually run: a trusted hop lets the caller choose its own IP.

## Trying it

```bash
# Claude Code
claude mcp add --transport http flightroom https://<your console>/api/mcp

# MCP Inspector
npx @modelcontextprotocol/inspector
```
