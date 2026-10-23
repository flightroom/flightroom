![Flightroom](docs/assets/banner.png)

# Flightroom

[![License](https://img.shields.io/github/license/flightroom/flightroom)](LICENSE)
[![Release](https://img.shields.io/github/v/release/flightroom/flightroom)](https://github.com/flightroom/flightroom/releases)
[![Docker Pulls](https://img.shields.io/docker/pulls/lory1990/flightroom)](https://hub.docker.com/r/lory1990/flightroom)
[![Documentation](https://img.shields.io/badge/docs-flightroom.dev-FE7F2D)](https://flightroom.dev/documentation/)

**Build apps and AI agents by describing them. Ship them in one click, inside
IT's rules.**

Flightroom is an open-source enterprise platform where anyone in a company can
describe the app or the agent they need. The AI writes the code in your own Git
repositories, your engineers review it, and one click deploys it to your
Kubernetes through GitOps and Argo CD — with your single sign-on, your roles and
your AI models.

🔗 **Website:** [flightroom.dev](https://flightroom.dev/) ·
📖 **Documentation:** [flightroom.dev/documentation](https://flightroom.dev/documentation/) ·
🖥️ **Hosted console:** [console.flightroom.dev](https://console.flightroom.dev/)

## Try it in 60 seconds

**Hosted console — nothing to install.** Sign up free at
[console.flightroom.dev](https://console.flightroom.dev), create your
organization and describe your first app.

**Self-hosted — one container.** The all-in-one image bundles Flightroom,
MongoDB, Redis and Nginx:

```bash
docker run -d --name flightroom --restart unless-stopped \
  -p 8080:80 -v flightroom-data:/data lory1990/flightroom:all-in-one
```

Open http://localhost:8080 and create the first user.

Either way, the
[**quick start**](https://flightroom.dev/documentation/docs/quick-start) takes
you from an empty organization to an app in your own repositories, and
[**deploy to Kubernetes**](https://flightroom.dev/documentation/docs/kubernetes/overview)
puts it in front of users.

## How it works

1. **Describe it.** Write what the app or agent should do, the way you would
   explain it to a colleague. Flightroom proposes the web interfaces and backend
   backends it needs, and you adjust the proposal.
2. **The AI builds it in your repositories.** Each repository is created in your
   GitHub, GitLab or Azure DevOps from one of Flightroom's templates, CI
   included, and the AI writes the first version on a branch.
3. **Your team reviews it.** Every AI change starts on an `ai/…` branch and can
   be opened as a pull request. Protect the base branch and it goes through your
   code review and your CI.
4. **One click ships it.** Deploying commits the deployment to Git, your Argo CD
   syncs it, and the app gets its own URL with TLS in every environment.

```mermaid
flowchart LR
    USER((You)) -- "describe the app" --> FR
    subgraph FR [Flightroom]
        AI[AI proposal and code changes] --> DEP[Deploy]
    end
    AI -- "ai/… branch, pull request" --> GIT[(Your Git repositories)]
    GIT -- "CI builds the images" --> REG[(Registry)]
    DEP -- "GitOps commit" --> OPS[(GitOps repository)]
    OPS -- "sync" --> ARGO[Your Argo CD]
    ARGO --> K8S[Kubernetes: one namespace per environment]
```

The console never holds cluster credentials: every deploy is a Git commit your
Argo CD applies.

## What you get

**Build with AI**

- **Generate a domain** — on an empty functional domain the AI proposes up to
  three web interfaces and three backends, and you edit the proposal
  before anything is created.
- **Refine through chat** — ask for the next change on any frontend, backend or
  domain; it lands on its own branch, ready to open as a pull request, apply or
  discard.
- **Your stack** — web interfaces in React, Angular or Vue; backends in Node.js,
  Python, Spring Boot or Quarkus. An agent is a backend that calls the AI model
  your organization chose: built, reviewed and deployed like any other.
- **Console assistant** — ask the console to act for you, with a confirmation
  before anything destructive.
- **Maintenance agents** — agents that run on a schedule, or on demand, against
  your projects.

**Ship to Kubernetes**

- **GitOps and Argo CD** — Flightroom sets up Argo CD for you, with one
  Application per app and environment, automated sync and self-heal.
- **Environments as namespaces** — dev, UAT, production or your own stages, each
  a Kubernetes namespace with its own host, exposed through the Gateway API with
  TLS from cert-manager.
- **Immutable deployments, one-click rollback** — every deploy is a snapshot;
  rolling back re-activates the previous one.
- **Config maps, secrets and resources** — one value per environment, and
  databases attached to the backends that need them.
- **Build status, live** — pipeline runs from GitHub Actions, GitLab CI and Azure
  DevOps, streamed to the console.

**Inside IT's rules**

- **Your sign-on** — Microsoft Entra ID, Google or Auth0, or local accounts.
- **Your roles** — organization and project roles; viewers cannot request or
  apply AI changes. See
  [guardrails](https://flightroom.dev/documentation/docs/build-with-ai/guardrails).
- **Your AI models** — Claude through Anthropic, Azure AI Foundry or AWS
  Bedrock, GPT through Azure OpenAI, or Gemini, with your organization's own
  credentials. Admins can restrict a project to some models or turn AI off for
  it.
- **Your cloud** — self-host on your Kubernetes, in your cloud or on-premise.
  Open source under Apache-2.0.

### Frontends served by Flightroom

Not every web interface needs its own container. Flightroom can also store the
build of a frontend, decide which version each environment serves and hand the
host application its runtime configuration, composed with Module Federation:

- **Independent releases** — publish a frontend and assign it to an
  environment; the host application is untouched.
- **One build, every environment** — per-environment variables reach the browser
  at boot, so the same artifact serves DEV, UAT and PROD.
- **Module Federation, configured for you** — the console generates the Vite or
  Webpack configuration your host needs.
- **Your storage** — artifacts on the hub, in your own AWS S3, Azure Blob or
  Google Cloud Storage bucket, on your CDN, or on-premise.
- **Canary releases** — a random percentage, a sticky share of browsers or an
  explicit list of enrolled users.
- **Dependency analysis** — scan your frontend repositories and align peer
  dependencies across them.

![The frontends of a project, with the version, the host and the canary split each one is serving](docs/assets/frontends-dashboard.png)

## Use it from your AI client (MCP) 🤖

Flightroom runs a remote [MCP](https://modelcontextprotocol.io) server, so
Claude, ChatGPT, Gemini, Claude Code, Cursor, VS Code and Gemini CLI can read
your projects, create and change frontends and backends, and deploy, with your
role on each project. The client signs in with OAuth: you log in to the console,
pick the projects to share and whether the client may change things.

| Console | MCP server URL |
| --- | --- |
| Hosted | `https://console.flightroom.dev/api/mcp` |
| Self-hosted | `https://<your console>/api/mcp` (shown in Settings → Access → AI assistants) |

- **Claude, ChatGPT, Gemini** — add the URL as a custom connector (remote MCP
  server) and sign in when asked.
- **Claude Code** — add it, then run `/mcp` to sign in:

  ```bash
  claude mcp add --transport http flightroom https://console.flightroom.dev/api/mcp
  ```

- **Cursor** — `~/.cursor/mcp.json` (or `.cursor/mcp.json` in the project):

  ```json
  { "mcpServers": { "flightroom": { "url": "https://console.flightroom.dev/api/mcp" } } }
  ```

- **VS Code** — `.vscode/mcp.json`, then **Start** on the server to sign in:

  ```json
  { "servers": { "flightroom": { "type": "http", "url": "https://console.flightroom.dev/api/mcp" } } }
  ```

- **Gemini CLI** — `~/.gemini/settings.json`, then `/mcp auth flightroom`:

  ```json
  { "mcpServers": { "flightroom": { "httpUrl": "https://console.flightroom.dev/api/mcp" } } }
  ```

A client that cannot do OAuth (a script, a CI job) can send a project API key
instead, as `Authorization: Bearer <api key>`; it reaches that project only.

On a self-hosted install the MCP server is **off by default**. Turn it on with:

```bash
MCP_ENABLED=true
FRONTEND_URL=https://<your console>
JWT_SECRET=<your own secret, openssl rand -hex 32>
```

[docs/MCP.md](docs/MCP.md) covers scopes, the consent page, revoking access,
reverse proxy setup and every `MCP_*` variable; the
[MCP server guide](https://flightroom.dev/documentation/docs/build-with-ai/mcp-server/)
is the user-facing version.

## Documentation 📚

The full documentation lives at
**[flightroom.dev/documentation](https://flightroom.dev/documentation/)**:

- **[Quick start](https://flightroom.dev/documentation/docs/quick-start)** - describe an app, review it, deploy it
- **[Core concepts](https://flightroom.dev/documentation/docs/core-concepts)** - organizations, projects, domains, frontends, backends, environments and deployments
- **[Generate a domain with AI](https://flightroom.dev/documentation/docs/build-with-ai/generate-a-domain)** - from a description to repositories and a first version
- **[AI changes](https://flightroom.dev/documentation/docs/build-with-ai/ai-changes)** - branches, pull requests and what the AI can touch
- **[Deploy to Kubernetes](https://flightroom.dev/documentation/docs/kubernetes/overview)** - GitOps repositories, Argo CD and environments
- **[Self-hosting](https://flightroom.dev/documentation/docs/self-hosting/helm)** - Docker, Docker Compose, Helm, Terraform
- **[Frontends](https://flightroom.dev/documentation/docs/frontends/overview)** - versions, hosting options, canary releases and the generated [Module Federation configuration](https://flightroom.dev/documentation/docs/integration/overview)

Project reference:

- **[AI providers](docs/AI-PROVIDERS.md)** - The AIs of an organization and the system AI of an installation
- **[AI code changes](docs/AI-CODE-CHANGES.md)** - How the AI edits a repository and opens the change
- **[Argo CD](docs/ARGOCD.md)** - Handing the GitOps repositories of a project to an Argo CD on another cluster: the account, its RBAC and the read-only repository tokens
- **[Exposure](docs/EXPOSURE.md)** - Exposing environments through the Gateway API, with TLS from cert-manager
- **[Secrets](docs/SECRETS.md)** - Encrypting the credentials stored for a project
- **[Remote MCP server](docs/MCP.md)** - Letting AI clients use the console through OAuth, on the projects the user picks
- **[Anonymous telemetry](docs/TELEMETRY.md)** - What the daily ping contains and how to turn it off
- **[Commit Conventions](COMMIT_CONVENTIONS.md)** - Conventional Commits specification
- **[Changelog](CHANGELOG.md)** - Project version history
- **[Security](SECURITY.md)** - Security policy and procedures

## Self-hosting

### Docker Compose

```bash
docker compose up -d
```

### Everything in a single container 📦

If you do not want to run MongoDB and Redis yourself, use the **all-in-one**
image: it contains Flightroom, MongoDB, Redis and Nginx. One container, one
volume, nothing else to start.

```bash
docker run -d --name flightroom --restart unless-stopped \
  -p 8080:80 -v flightroom-data:/data lory1990/flightroom:all-in-one
```

Open http://localhost:8080 and create the first user. That is all.

What you should know about it:

- **Everything persistent lives in `/data`**: database (`/data/db`), Redis dump
  (`/data/redis`), uploaded frontends (`/data/microfrontends`), repositories
  cloned for AI changes (`/data/repositories`) and the JWT secret
  (`/data/secrets`). Mount that single volume and the installation survives an
  image upgrade.
- **The JWT secret is generated on the first start** and kept in the volume, so
  tokens are not signed with a well known key. Pass `JWT_SECRET` yourself if you
  prefer to manage it.
- **MongoDB and Redis only listen on the loopback of the container**: they are
  reachable by the backend and by nobody else, so there is no database port to
  firewall and no default password to change. Only port 80 is published.
- **MongoDB runs as a single node replica set** (`MONGO_REPLICA_SET=rs0`), which
  is what makes transactions available to the backend. Set the variable to an
  empty string to run a plain standalone MongoDB instead.
- Every [environment variable](#environment-variables-) of the table below works
  here too, for example
  `-e REGISTRATION_ALLOWED=true -e FRONTEND_URL=https://flightroom.example.com`.
- The four processes are supervised: they are restarted when they crash and, if
  one of them cannot start at all, the container exits instead of pretending to
  be healthy. Logs of all of them are in `docker logs flightroom`, and
  `docker exec flightroom supervisorctl status` shows their state.

Prefer a compose file? A single service is enough:

```yaml
services:
  flightroom:
    image: lory1990/flightroom:all-in-one
    restart: unless-stopped
    ports:
      - "8080:80"
    volumes:
      - flightroom-data:/data

volumes:
  flightroom-data:
```

To build the image yourself, compile the workspace first, exactly like the
standard image does:

```bash
pnpm install && pnpm build
docker build -f Dockerfile.all-in-one -t flightroom:all-in-one .
```

> The all-in-one image trades isolation for simplicity: a single container means
> a single failure domain and no way to scale a service on its own. For
> production installations, or whenever you already run a managed MongoDB or
> Redis, use the `docker-compose.yaml` above or the Helm chart below.

### Kubernetes with Helm ⎈

The chart lives in [`helm/flightroom`](helm/flightroom/README.md) and every
release publishes it to `oci://ghcr.io/flightroom/charts/flightroom`:

```bash
helm install flightroom oci://ghcr.io/flightroom/charts/flightroom \
  --namespace flightroom --create-namespace \
  --set env.NOSQL_DATABASE_URL="mongodb://root:example@mongodb:27017" \
  --set env.REDIS_URL="redis://redis:6379" \
  --set envSecrets.JWT_SECRET="$(openssl rand -hex 32)"
```

Every [environment variable](#environment-variables-) of the table below is
configurable from `values.yaml`: plain ones under `env` (rendered into a
ConfigMap), sensitive ones under `envSecrets` (rendered into a Secret), and both
maps accept any additional variable you need.

```yaml
env:
  FRONTEND_URL: https://console.example.com
  REGISTRATION_ALLOWED: false
  NOSQL_DATABASE_URL: mongodb://root:example@mongodb:27017
  REDIS_URL: redis://redis:6379
envSecrets:
  JWT_SECRET: a-random-32-bytes-string
```

The chart also handles ingress, persistence of the uploaded frontends,
probes on `/api/echo`, autoscaling and secrets kept outside of `values.yaml`
(`existingSecret`, `extraEnv`). MongoDB and Redis are not deployed by the chart:
point it at your own instances. More than one replica (or autoscaling) needs a
`ReadWriteMany` volume for the uploaded frontends.

Chart `0.3.0` renamed the chart from `mfe-orchestrator`: see the
[chart README](helm/flightroom/README.md) before upgrading an existing release.

### Terraform (OpenTofu)

A template lives in the `terraform` folder:

```bash
cd terraform
terraform init
terraform apply
```

## Environment variables 🔧

The database, Redis and SMTP variables have no built-in default: the values below
are examples, and leaving one empty skips the feature it configures rather than
falling back to it.

| Variable                               | Default / example                                                                                 | Description                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `FRONTEND_URL`                         | `http://localhost:3000`                                                                           | URL of the console.                                             |
| `BACKEND_URL`                          | _(empty, falls back to `FRONTEND_URL` + `/api`)_                                                  | Public URL of the API, written into the generated configuration. |
| `PORT`                                 | `3000`                                                                                            | Port the backend listens on.                                    |
| `NODE_ENV`                             | `prod` _(development/prod/test/local)_                                                            | Node.js environment mode. Any other value stops the boot.       |
| `REGISTRATION_ALLOWED`                 | `true`                                                                                            | If `true`, allows new user registration.                        |
| `ALLOW_EMBEDDED_LOGIN`                 | `true`                                                                                            | If `true`, enables the login system within the application.     |
| `JWT_SECRET`                           | `your-secret-key`                                                                                 | Secret key for JWT generation and validation.                   |
| `SECRETS_ENCRYPTION_KEY`               | _(empty)_                                                                                         | 32 bytes, base64 or hex (`openssl rand -base64 32`). Encrypts the credentials stored for a project — bucket keys, connection strings, repository tokens — and stops the API from returning them. Empty, they are stored in the clear. See [docs/SECRETS.md](docs/SECRETS.md). |
| `NOSQL_DATABASE_URL`                   | `mongodb://localhost:27017/flightroom`                                                            | MongoDB database connection URL.                                |
| `NOSQL_DATABASE_NAME`                  | `flightroom`                                                                                      | MongoDB database name.                                          |
| `NOSQL_DATABASE_USERNAME`              | `root`                                                                                            | MongoDB username.                                               |
| `NOSQL_DATABASE_PASSWORD`              | `example`                                                                                         | MongoDB password.                                               |
| `REDIS_URL`                            | `redis://localhost:6379`                                                                          | Redis server connection URL.                                    |
| `REDIS_PASSWORD`                       | _(empty)_                                                                                         | Password for Redis access (if set).                             |
| `AI_PROVIDER`                          | _(empty)_ (`anthropic` when `ANTHROPIC_API_KEY` is set)                                           | The system AI offered to every organization: `anthropic`, `azure-foundry`, `aws-bedrock`, `gemini`, `azure-openai`. Each provider has its own `ANTHROPIC_*`, `AZURE_FOUNDRY_*`, `AWS_BEDROCK_*`, `GEMINI_*` or `AZURE_OPENAI_*` variables. See [docs/AI-PROVIDERS.md](docs/AI-PROVIDERS.md). |
| `AI_MAX_EFFORT`                        | _(empty)_                                                                                         | Highest reasoning effort users may pick with the system AI: `low`, `medium`, `high`, `xhigh` or `max`. |
| `ASSISTANT_RATE_LIMIT_MAX`             | `20`                                                                                              | Assistant questions per IP per minute.                          |
| `REPOSITORIES_FOLDER`                  | `/repositories` (`/data/repositories` in the all-in-one image)                                    | Where repositories are cloned to be edited with AI. A cache.    |
| `REPOSITORIES_MAX_SIZE_MB`             | `500`                                                                                             | Repositories bigger than this on disk are refused.              |
| `REPOSITORIES_EVICT_AFTER_DAYS`        | `14`                                                                                              | Clones not used for this many days are deleted.                 |
| `MICROFRONTEND_HOST_FOLDER`            | `/upload-microfrontends`                                                                          | Folder holding the uploaded builds of the frontends served by Flightroom. |
| `CODE_REPOSITORY_GITHUB_CLIENT_ID`     | _(empty)_                                                                                         | Client ID for GitHub OAuth authentication.                      |
| `CODE_REPOSITORY_GITHUB_CLIENT_SECRET` | _(empty)_                                                                                         | Client secret for GitHub OAuth authentication.                  |
| `ARGOCD_ALLOW_INSECURE_HTTP`           | `false`                                                                                           | Lets a project point Argo CD initialization at an `http://` Argo CD URL. For a local cluster only: the Argo CD token and the repository credentials would travel in the clear. See [docs/ARGOCD.md](docs/ARGOCD.md). |
| `EMAIL_SMTP_HOST`                      | `smtp.example.com`                                                                                | SMTP server host. Unset, the app sends nothing: registration and invitations become immediate, and the password reset is refused outright — it only exists as an emailed link. |
| `EMAIL_SMTP_PORT`                      | `587`                                                                                             | SMTP server port (e.g., 587 for TLS).                           |
| `EMAIL_SMTP_SECURE`                    | `false`                                                                                           | If `true`, uses secure connection (SSL/TLS).                    |
| `EMAIL_SMTP_USER`                      | _(empty)_                                                                                         | Username for SMTP authentication.                               |
| `EMAIL_SMTP_PASSWORD`                  | _(empty)_                                                                                         | Password for SMTP authentication.                               |
| `EMAIL_SMTP_FROM`                      | `no-reply@example.com`                                                                            | Sender email address.                                           |
| `AUTH0_DOMAIN`                         | _(empty)_                                                                                         | Auth0 tenant domain.                                            |
| `AUTH0_CLIENT_ID`                      | _(empty)_                                                                                         | Client ID of the Auth0 application.                             |
| `AUTH0_AUDIENCE`                       | _(empty)_                                                                                         | API Audience configured in Auth0. Required for Auth0 login: the backend verifies the token's signature, issuer and audience. |
| `AUTH0_SCOPE`                          | `openid profile email`                                                                            | OAuth scopes (space-separated)                                  |
| `AZURE_ENTRAID_TENANT_ID`              | _(empty)_                                                                                         | Azure Entra ID tenant ID.                                       |
| `AZURE_ENTRAID_CLIENT_ID`              | _(empty)_                                                                                         | Client ID of the registered Azure application.                  |
| `AZURE_ENTRAID_REDIRECT_URI`           | _(empty)_                                                                                         | Redirect URI for Azure authentication.                          |
| `AZURE_ENTRAID_AUTHORITY`              | `https://login.microsoftonline.com`                                                               | Authentication authority URL.                                   |
| `AZURE_ENTRAID_SCOPES`                 | `openid profile email`                                                                            | Required scopes during login.                                   |
| `AZURE_ENTRAID_API_AUDIENCE`           | _(empty)_                                                                                         | Protected API identifier in Azure.                              |
| `GOOGLE_CLIENT_ID`                     | _(empty)_                                                                                         | Client ID for Google OAuth authentication.                      |
| `GOOGLE_CLIENT_SECRET`                 | _(empty)_                                                                                         | Client secret for Google OAuth authentication.                  |
| `GOOGLE_REDIRECT_URI`                  | _(empty)_                                                                                         | Redirect URI for Google OAuth.                                  |
| `GOOGLE_AUTH_SCOPE`                    | `https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile` | Required scopes to get Google email and profile.                |
| `GOOGLE_AUTH_HOSTED_DOMAIN`            | _(empty)_                                                                                         | Restricts the Google login to a single Workspace domain.        |
| `GOOGLE_API_AUDIENCE`                  | _(empty)_                                                                                         | Protected API identifier for Google.                            |
| `ALLOWED_ORIGINS`                      | _(empty)_                                                                                         | List of allowed URLs for cross-origin requests comma separated. |
| `ALLOWED_SERVE_ORIGINS`                | _(falls back to `ALLOWED_ORIGINS`)_                                                               | Same list, applied only to the `/serve/*` endpoints.            |
| `RATE_LIMIT_MAX`                       | `100`                                                                                             | Requests per IP per minute.                                     |
| `TRUST_PROXY`                          | `127.0.0.1` _(in the Docker images)_                                                              | Proxies trusted for `X-Forwarded-For`: `true` or a comma separated list of addresses/CIDRs (`loopback`, `uniquelocal` work too); a hop count is refused. Behind a Kubernetes ingress add its hop, e.g. `loopback,10.0.0.0/8`, or every client shares one rate limit bucket. |
| `MCP_ENABLED`                          | `false`                                                                                           | Turns on the remote MCP server and its OAuth endpoints. Requires `FRONTEND_URL` and your own `JWT_SECRET` of at least 32 bytes (`openssl rand -hex 32`). See [docs/MCP.md](docs/MCP.md). |
| `MCP_API_KEY_ENABLED`                  | `true`                                                                                            | Lets MCP clients that cannot do OAuth authenticate with a project API key (`Authorization: Bearer <key>` or `api-key` header). See [docs/MCP.md](docs/MCP.md#fallback-a-project-api-key). |
| `MCP_RATE_LIMIT_MAX`                   | `120`                                                                                             | MCP requests per minute for each OAuth grant or API key.        |
| `MCP_DCR_ENABLED`                      | `true`                                                                                            | Lets MCP clients register themselves (RFC 7591).                |
| `MCP_CIMD_ENABLED`                     | `true`                                                                                            | Accepts MCP clients identified by a metadata document URL.      |
| `CIMD_ALLOWED_HOSTS`                   | _(any)_                                                                                           | Comma separated hosts allowed to publish client metadata documents. Clients from listed hosts show as verified on the consent page; with no list every CIMD client is marked unverified. |
| `OAUTH_ISSUER_URL`                     | _(empty, falls back to `BACKEND_URL`)_                                                            | Issuer of the MCP access tokens.                                |
| `MCP_RESOURCE_URL`                     | _(empty, falls back to the issuer + `/mcp`)_                                                      | Public URL of the MCP endpoint.                                 |
| `NPM_REGISTRY_URL`                     | `https://registry.npmjs.org`                                                                      | Registry queried by the dependency analysis for published versions. |
| `SENTRY_DSN`                           | _(empty)_                                                                                         | Sentry DSN. Leave empty to disable error reporting.             |
| `MARKETING_OPT_IN_ENABLED`             | `false`                                                                                           | If `true`, the registration form collects a marketing consent, which the profile page can then change. |
| `MARKETING_OPT_IN_VERSION`             | `1`                                                                                               | Version of the consent text, stored together with the consent.  |
| `TELEMETRY_DISABLED`                   | _(empty)_                                                                                         | If `true`, turns off the anonymous telemetry ping.              |
| `DO_NOT_TRACK`                         | _(empty)_                                                                                         | If `1`, turns off the anonymous telemetry ping.                 |
| `TELEMETRY_ENABLED`                    | _(empty)_                                                                                         | Explicit switch for the telemetry ping. See [docs/TELEMETRY.md](docs/TELEMETRY.md) for how the three switches interact. |
| `TELEMETRY_ENDPOINT`                   | `https://telemetry.mfe-orchestrator.dev/api/telemetry/self-hosted`                                | Where the anonymous ping is sent.                               |
| `TELEMETRY_INTERVAL_HOURS`             | `24`                                                                                              | Hours between two pings.                                        |

## Anonymous telemetry 📡

Self-hosted installations send **one anonymous ping per day**, so that we know how many installations are alive and on which version. It is **on by default** and contains only aggregate counters:

```json
{
  "installationId": "3f2b9c14-6d8e-4a17-9f0b-2c5d7e81a4b6",
  "version": "1.0.0",
  "nodeVersion": "24.4",
  "projects": 2,
  "frontends": 12,
  "environments": 3,
  "users": 4,
  "deploymentsLastWeek": 5
}
```

That is the whole payload: no names, no emails, no URLs, no hostnames, no project or application content. It is never sent when `NODE_ENV` is not `prod`, so development and CI runs are not counted.

To turn it off:

```yaml
TELEMETRY_DISABLED: "true"
```

Every start logs what is sent and how to disable it, and `GET /api/telemetry/status` shows the exact payload of your installation before it leaves. Full details, field by field, in **[docs/TELEMETRY.md](docs/TELEMETRY.md)**.

## Local development 🛠️

The project is a **pnpm workspaces monorepo** built with Turbo, linted and
formatted with Biome, with Lefthook git hooks and commitlint-enforced
conventional commits. The **backend** is Fastify + TypeScript (layered
models → services → controllers → plugins, MongoDB with Mongoose, Redis for
caching, multi-auth: local JWT, Auth0, Google OAuth, Azure Entra ID). The
**frontend** is React + TypeScript (rendered through
`@flightroom/design-system` on Tailwind CSS, React Query + Zustand, React
Router, react-hook-form, react-i18next).

### Prerequisites

- Node.js 21+ and pnpm
- Docker and Docker Compose

### Quick start

1. **Clone the repository** 📝

```bash
git clone https://github.com/flightroom/flightroom.git
cd flightroom
```

2. **Install dependencies** 📦

```bash
pnpm install
```

3. **Start MongoDB and Redis** 🐳

```bash
cd docker-local
docker compose -f docker-compose-development.yaml up -d
```

4. **Create the environment file** 🔧 in `./backend/.env`:

```bash
NOSQL_DATABASE_URL=mongodb://root:example@localhost:27018/admin
NOSQL_DATABASE_USERNAME=root
NOSQL_DATABASE_PASSWORD=example
REDIS_URL=redis://localhost:6379

REGISTRATION_ALLOWED=true
ALLOW_EMBEDDED_LOGIN=true
NODE_ENV=development
MICROFRONTEND_HOST_FOLDER=/path/to/your/frontends

# Optional: an AI for the assistant and the AI code changes
ANTHROPIC_API_KEY=your_anthropic_api_key

# Optional: GitHub OAuth for code repository integration
CODE_REPOSITORY_GITHUB_CLIENT_ID=your_github_client_id
CODE_REPOSITORY_GITHUB_CLIENT_SECRET=your_github_client_secret
```

5. **Start the development servers** 🚀

```bash
pnpm dev
```

### Available commands

```bash
# Development
pnpm dev              # Start backend and frontend (Turbo fans it out)

# Building
pnpm build            # Build all packages

# Code quality
pnpm lint             # Lint all packages with Biome
pnpm lint:imports     # Strip unused imports across the repo
pnpm format           # Format all packages with Biome
pnpm typecheck        # TypeScript check for all packages

# Testing
pnpm test             # Run unit tests in all packages
pnpm test:e2e         # Run the Playwright end-to-end suite
pnpm test:e2e:ui      # ...in the Playwright UI
pnpm test:e2e:report  # Open the last HTML report
```

### Development URLs

- **Backend**: `http://localhost:3000`
- **Frontend**: `http://localhost:5173`
- **API documentation**: `http://localhost:3000/api-docs`

## Contributing 🤝

1. **Fork the repository** 🍴
2. **Create your feature branch** 🌱

```bash
git checkout -b feature/AmazingFeature
```

3. **Follow the development guidelines** 📋

   - Use conventional commits (feat, fix, chore, docs, etc.), enforced by commitlint
   - Code is linted and formatted with Biome; Lefthook runs the checks before each commit
   - Write tests for new features and keep TypeScript strict mode happy
   - Translate every user-facing string, in Italian and English
   - Update the documentation for user-facing changes

4. **Commit your changes** ✍️

```bash
git commit -m 'feat: add some amazing feature'
```

5. **Push to the branch** ⬆️

```bash
git push origin feature/AmazingFeature
```

6. **Open a Pull Request** 🔗

## License

Licensed under the [Apache License, Version 2.0](LICENSE).

---

If Flightroom is useful to you, a
[⭐ on GitHub](https://github.com/flightroom/flightroom) helps the
project get found.
