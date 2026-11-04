# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [15.2.0] - 2026-11-04

### Added

- **Continuous Deployment Per Container And Environment**: a backend or a DOCKER frontend turns on **Continuous deployment** for each environment next to its version (`continuousDeploymentEnvironmentIds` in the API and through MCP). There, every deploy writes `imagePullPolicy: Always` and the label `updatedAt` (the time of the deploy) on the pods: the values file changes at each deploy, so Argo CD syncs and the pods roll out pulling the image again, even when the tag is the same. With Argo CD, when the CI registers again the tag an environment deployed continuously runs, Flightroom refreshes its Application and restarts its Deployment there through Argo CD. The chart's `deployment.yaml` is updated on the branches where it was never changed; a template a team changed is left as it is and needs the two new blocks for it
- **Pick The Telemetry Provider Of A Project**: a **Telemetry** tab in the project settings picks where the applications send their traces, metrics and logs: OpenTelemetry (OTLP, the default), Azure Application Insights, AWS CloudWatch and X-Ray (ADOT), Google Cloud Observability or Datadog. Every GitOps deploy writes the Secret `telemetry.flightroom` with the variables of the provider in the environments switched on, which every container reads after its config maps; Edit with AI and `context_get` tell the agents how to instrument the code for it, and `project_update` takes `telemetry`, its secret fields encrypted at rest and never sent back. No cloud credential reaches the applications
- **Every Type Of Resource Defines Variables Of Its Own**: a typed resource (auth0, smtp, redis...) can add the variables its variant lacks, under its own prefix, as a generic one does; a variable named as one the variant sets is refused, on a change of variant too
- **Sandbox Usage, Apart From The AI Tokens**: the sandbox time leaves the **AI tokens** card for a card of its own, **Sandbox usage**, on the same pages (domain, frontend, backend, project, organization): the minutes the sandboxes ran scripts and commands, the minutes they stayed up, the commands, and a bar chart of the minutes the AI spent coding each day (Edit with AI and the missions, by UTC day; the live previews not counted). The project splits it by feature, the organization by project. The usage API gives the days in `sandbox.codingByDay`
- **The Galaxy Map Full Screen**: the galaxy map of the domains and of the backends has a **Full screen** button next to **Show everything**; Esc, or a click that opens a world, brings it back

### Changed

- **MongoDB Servers Are Databases**: the **MongoDB servers** page is now part of **Databases** (Settings → Infrastructure): a database of engine **MongoDB** is connected by **Connection string** (a self-hosted server), **Atlas service account** or **Azure Cosmos DB (Entra service principal)**, and its page shows **Created databases** with every rule of 15.1.0 kept (existing users and databases refused, the removal dialog, a database or a project with created databases not deleted, its address locked while it has some). The servers registered with 15.1.0 are moved at the first start, with their ids, credentials and created databases. Through MCP, `databases_list`, `database_get` and `database_test` cover the MongoDB ones and `mongo_servers_list`, `mongo_server_get` and `mongo_server_test` are gone; `provisioned_database_create` and `provisioned_databases_list` take `databaseId` in place of `serverId`. The routes are `/databases/:databaseId/provisioned-databases`
- **AI Tokens Read As 12k And 4M**: the **AI tokens** card writes the counts compactly (950, 1.2k, 12k, 4.6M), the exact figure on hover in its table

### Removed

- **The Boot Migrations Up To 15.1**: the data migrations of 11.0 (the version each environment runs), 11.7 (the kube-green schedules), 15.0 (the variables of the backends with no value) and 15.1 (the design systems of the frontends) are gone: upgrade to 15.2.0 from 15.1.0 or later. The move of the MongoDB servers to the databases has no way back: do not roll back below 15.2.0 once it ran

## [15.1.0] - 2026-11-04

### Added

- **Databases Created On A MongoDB Server, One Per Environment**: a project registers MongoDB servers on the new **MongoDB servers** page (from Settings → Infrastructure): a self-hosted one by the URI of an account allowed to create users, or an Atlas project and cluster by a service account, the credentials encrypted at rest and never shown again. On a server, **Create database** makes a database and a user of the same name with `readWrite` and `dbAdmin` on it only, with a generated password nobody sees, and can link it at once to a `mongodb` resource (variant `connectionString`) in one environment: the connection string and the database name of the resource there are written by Flightroom, so four databases feed `dev`, `test`, `staging` and `prod` of one resource. A second database for the same environment of a resource is refused, and the resource shows which environments a created database feeds. **Remove** asks what goes with it: only the record in Flightroom, the user too, or the user and the database with its data, after typing its name. A linked database is unlinked first, and a resource or a server is not deleted while a created database feeds it or lives on it. Through MCP: `mongo_servers_list`, `mongo_server_get`, `mongo_server_test`, `provisioned_databases_list`, `provisioned_database_get`, `provisioned_database_create`, `provisioned_database_link`, `provisioned_database_unlink` and `provisioned_database_delete`; registering or editing a server stays in the console. A user of that name already on the server is refused, never taken over, and so is a database of that name that already holds collections (on Atlas the new user looks and is deleted again); while a server has databases its provider and address stay as they are (its credentials can be rotated)
- **Databases Created On An Azure Cosmos DB For MongoDB (RU) Account**: the third kind of MongoDB server, reached through Azure Resource Manager with an Entra service principal (DocumentDB Account Contributor on the resource group of the account) on an account with role-based access control on (`EnableMongoRoleBasedAccessControl`, which **Test** checks). Each database (refused when it already exists) and its user (a Mongo user definition with `readWrite` and `dbAdmin`) are created there, and the resource gets the account's connection string on port 10255 with `SCRAM-SHA-256`
- **Deleting An Environment Asks What Becomes Of Its Databases**: when databases created on a MongoDB server feed a resource in an environment, deleting it asks, for all of them, whether to unlink them, remove them from Flightroom only, delete their users, or delete users and data after typing the name of the environment. They are dealt with before the environment goes; if one fails the environment stays, and the message names those already done. Through MCP, `environment_delete` takes the same choice in `provisionedDatabases`
- **A Project With MongoDB Servers Is Not Deleted With Them**: deleting a project that still has MongoDB servers is refused naming them, as their databases and users live outside the console: remove the databases, choosing what becomes of each, and the servers first. Creating, linking and removing a provisioned database from its server, and deleting an environment removing the users or the data of its databases, share the budget of the connection tests (10 a minute per person), through the console and through MCP; removing from Flightroom only, and unlinking, are not counted. A user Flightroom created and could not remove again after a failed create stays listed, marked **User left on the server**, until it is removed. On Atlas, creating and dropping a database go through the driver: the backend's egress IP address must be in the IP Access List of the Atlas project, which **Test** (Admin API only) does not check
- **A Resource Fed By A Created Database Keeps Its Connection There**: while a database created on a MongoDB server feeds a resource in an environment, the resource refuses a change of variant and a value typed for its connection string or database name in that environment: unlink the database first
- **Sandboxes Shared By Frontend Or Backend, Or By Project**: the sharing setting of the installation gains **component** (one sandbox per frontend or backend; a job on several falls back to their domain's sandbox, else the project's) and **project**. No sandbox is ever shared across projects or organizations. The OpenShell status card leaves the AI tab of the organization, as the installation page already shows it
- **The Files Of A Proposal Open In A Dialog**: an AI change proposal no longer spreads its diffs across the conversation: it shows how many files changed, and **View the changes** opens a dialog with every file and its diff

### Changed

- **The Design System Is Set On The Organization And The Project Only**: a frontend builds with the design system of its project, else the organization's. The frontend form loses its design system card, the frontend API and MCP tools their `designSystem` field, and `design_system_npmrc_get` its `frontendId`; a migration removes the design system the frontends had of their own, npmrc credentials included
- **A Resource Keeps Its Stored Credentials When Where It Connects Changes**: changing the host, URL, port or variant of a resource no longer refuses the update with `RESOURCE_SECRET_REENTRY_REQUIRED`: a credential sent back as the placeholder, or left out, keeps its stored value. The console drops the "type it again" banner and the forced fields

### Fixed

- **Agents Fly Around Their Own Domain On The Galaxy Map**: each ship orbits the galaxies of the worlds it works on, on a lane of its own, instead of every agent circling every domain on the same ring; the map of the backends shares the component
- **Off-Centre Orbits On The Galaxy Map**: the moons of a backend and the maintenance stations fly ellipses with their world at a focus, as the comets do, nested without crossing, and every lane of the ships is stretched

## [15.0.2] - 2026-11-04

### Fixed

- **The Settings Of A Frontend Save Again After Picking A Repository**: picking an existing repository for a frontend left on **Create new repository**, or switching its **Code repository** section off, no longer blocks **Save** without a word: the name of the repository to create, a field no longer shown, was still required

## [15.0.1] - 2026-11-04

### Fixed

- **No Endless Spinner On The Overview Of A Frontend Or A Backend, For Real**: 15.0.0 stopped one of the two components refetching the environments under the overview, the **Build and deploy** button; the **Deploy** dialog it carries kept doing it, so the overview of a frontend or a backend in a domain still spun forever. The environments of the project are now fetched only when nothing is cached, for every page and component reading them, so no child can start the loop again

## [15.0.0] - 2026-11-04

### Changed

- **Config Maps, Secrets And Resources Need Argo CD**: they reach a container only through the GitOps manifests Argo CD applies, so in a project whose Argo CD is not initialized they are now off everywhere: the console hides their pages, menu entries, pickers and sections (a direct URL shows a notice pointing to the Argo CD settings), sandbox previews no longer inject them, and creating or changing one, or attaching a new one to a backend, a frontend or a maintenance agent, is refused with `ARGOCD_REQUIRED_FOR_VARIABLES`, through the MCP tools too. Deleting stays allowed, and the ids already attached are kept, so everything comes back once Argo CD is initialized
- **Assistant Conversations Expire**: a conversation with the assistant nobody touched for `ASSISTANT_CONVERSATION_RETENTION_DAYS` (60 by default) is removed from the database, a deleted one counted from its deletion; until now they were kept forever, the deleted ones too. Changing the variable applies at the next start to the conversations already stored
- **Every Environment Variable Of A Backend Has A Value**: a variable of a backend no longer has the **Required** flag, and it can no longer be declared without a value: the console asks for the **Value** of a new one, and the API and `backend_create`, `backend_update` refuse a variable left with none, or with an empty one. To stop passing a variable, remove it; a secret one sent back without a value still keeps the stored one. At the first start, the variables of a backend saved with no value are removed, and the flag unset from the others. **Injected variables** no longer lists a variable of a backend as missing; those of a DOCKER frontend and of a maintenance agent are still declared only, required or not, as before, and their forms no longer show the **Value** field 14.2.0 gave them, which was never saved

### Fixed

- **No Endless Spinner On The Overview Of A Frontend Or A Backend**: the overview of a frontend or a backend in a domain, without the **Edit with AI** screen, no longer spins forever reloading its data: the **Build and deploy** button refetched the environments the page was waiting for, so the page unmounted and mounted it again without end, until the API answered `429`
- **No Endless Spinner On The Environments Page**: opening **Environments** from another page, such as **Deployments** with its **Manage environments** link, no longer leaves the page on its spinner once the environments are loaded

### Security

- **No Query Operators From The Account Routes**: password reset, account activation, login, forgot password, registration and invitation take the token, the email and the password as plain strings only, refusing anything else before the database is queried. An object such as `{"$ne": null}` in place of the reset token used to match whichever pending reset came first, so that anybody could set the password of an account with a reset under way
- **Patched minimatch And glob**: pnpm overrides pull the transitive `minimatch` to 11.0.4 and `glob` to 14.0.3, clearing two moderate advisories (GHSA-g3hv-75wg-m249, ReDoS via globstar; GHSA-3g3m-2fjr-6pw4, AbortSignal cancellation bypass)

## [14.2.0] - 2026-11-04

### Added

- **Config Maps And Secrets As Comets In The Galaxy**: each frontend and backend the galaxy shows gets its config maps on one elliptical orbit and its secrets on another, turned 120° from it, both with the world at a focus, each comet trailing its tail away from its world. A map several worlds receive is a comet of each of them; hovering it lights every world that receives it, a click opens it
- **Environment Variables Of A Backend Injected By Flightroom**: each variable of a backend takes a **Value**, which every deploy hands its container, the same in every environment; per environment values stay with config maps and secrets. A plain value goes in the `env` of the Helm values, before the platform's (`HTTP_PORT`, `LOG_LEVEL`, `PUBLIC_URL`...), which win a name set twice, and wins over every config map, secret and resource. A secret value goes in a Secret `<slug>.env` of its own in the configuration repository, `<environment>/backendEnv/<slug>.yaml`, the last of the `envFrom`. The values are encrypted at rest; a secret one never comes back from the API nor from `backend_get` and `backends_list`, only `valueSet`, and a variable sent back without a value keeps the stored one, an empty value clearing it. **Injected variables** lists them with the source `backend`, and a variable with a value is no longer missing. The coding agents learn that Flightroom sets a variable, never its value. A variable with no value is declared only, as before

### Changed

- **The Resources Of A Domain Laid Out As Those Of A Backend**: the **Resources** tab of the overview of a domain shows each resource its backends attach once, with what it hands out in each environment in a table, a credential never shown, as the overview of a backend does, instead of a list of names under each backend. Under its name, the backends of the domain using it, each detached from there by an editor; the backends attaching none are listed last
- **The Docs And OpenAPI Paths In The Summary**: the endpoints card of the **Summary** of a backend, and of a DOCKER frontend, lists its API docs and OpenAPI spec paths beside the port, or says they are not set, with a link to the settings where they are, so that a missing link to the Swagger no longer goes unnoticed
- **What A Person's AI Usage Cost**: `user_ai_usage` gives, beside the tokens of each period and of the total, `costs`, one amount per currency, priced by the token rates set on the AIs of the organization, so that "and what did it cost?" gets an answer from the assistant. Usage of an AI with no rates, as the system one, counts in the tokens only
- **The Domains Of The Galaxy On A Grid**: the galaxy lays the domains out row by row, the last row centred, rather than on a ring, as far apart as they were
- **The Editor Tab Kept When Switching Environment**: on the **Environments** page the tab open in the editor of an environment stays open when another environment is opened, and is kept in the URL (`?tab=`), so a link opens it; leaving the environments goes back to **General**

### Fixed

- **The Danger Zone Tab In Red**: the **Danger zone** tab of the frontend, backend and maintenance agent editors is red
- **Removing An Environment Variable Of A Backend**: the rows of the variables of a backend are centred, their trash is red, and removing one asks for confirmation first

### Security

- **JWT_SECRET Required**: the backend no longer starts without a `JWT_SECRET`, or with a placeholder one or one shorter than 32 bytes, whether MCP is on or not. With none set it used to sign the console session tokens with a well-known default key, so that anyone could forge an administrator's token. Set one (`openssl rand -hex 32`) in `envSecrets.JWT_SECRET` of the Helm chart before upgrading; the all-in-one image keeps generating its own on the first start
- **Self-Hosted GitLab URL Checked**: the URL of a self-hosted GitLab must be https, carry no credentials and not be localhost or a loopback, link-local or cloud metadata address, so that it can no longer reach the internals of the cluster; private hosts stay allowed. Its API calls no longer follow redirects, and the organization of an Azure DevOps repository is validated before it is used as a host
- **Micro-Frontend Files Confined To Their Folder**: `/serve/mfe/files/*` resolves the path asked for inside the folder of the micro-frontend, locally and on a storage, so that an encoded `..` can no longer read the other files of the pod
- **Tool Output Kept Apart From The Assistant's Instructions**: what the tools return reaches the model of the assistant wrapped as untrusted data, as for the coding agent, so that text in a log line can no longer act as instructions; promoting an environment, setting its replicas and creating or updating a config map or a global variable now ask for confirmation
- **The OS Packages Of The Images Upgraded Every Day**: the layer of the images that upgrades their Alpine and Debian packages no longer comes out of the build cache with old ones, but is rebuilt on the first build of each day, so that a fix released after the base image is picked up: the standard image ships `libexpat` 2.10.0 (CVE-2026-113351, CVE-2026-117610, CVE-2026-118370). The all-in-one image upgrades the Debian packages of its base too

## [14.1.0] - 2026-11-02

### Added

- **Delete A Domain From Its Settings**: the settings of a domain end with a **Danger zone** that deletes it, after typing its name. Its frontends and backends stay without a domain, unless **Also delete the frontends and backends of the domain** is ticked: then they go too, each as its own delete does, with their versions and deployments; its maintenance agents always stay. `DELETE /api/domains/:id` takes `?withMembers=true`, and `domain_delete` of MCP `withMembers`
- **A Logo For The Dark Theme**: `INSTALLATION_LOGO_DARK_URL` sets the logo the console shows in the dark theme, in the sidebar, the login page and the new project wizard, following the theme as it changes. The emails carry it too, their header being dark in both themes. Unset or empty, `INSTALLATION_LOGO_URL` serves both themes as before. Shipped in the Helm chart `values.yaml`
- **MCP: Logs Of Several Applications At Once**: `application_logs_search` reads the logs of several applications in one or more environments in one call, every backend and container frontend each environment runs unless `slugs` are given, from every pod without naming one, merged oldest first as `<time> <environment>/<pod> <text>`. `filter` and `exclude` ignore case, `minLevel` keeps the lines at a level or above, read from the level of a JSON line or a level word at the start of a text one, a stack trace following its error, and a pod that restarted gives the lines of the container before too. At most 60 pods are read; `sources` says what each application gave and why one could not be read. The `filter` of `application_logs_get` stays case sensitive, as its description now says
- **MCP: Status Of The Environments**: `environment_status` says, for one or more environments, every one when none is given, the deployment each serves and, per backend and container frontend, the version it ships, where Argo CD stands with it and its pods with their restarts
- **MCP: Waiting For A Build Or A Deploy**: `build_wait` waits up to 240 seconds for the version a `backend_trigger_build` or a `frontend_trigger_build` started to be registered, and says where its run stands, with the end of the logs of its failed jobs when it failed. `deployment_wait` waits as long for the deploys `deploy` returned to roll out through Argo CD, stopping once every application they updated is healthy, or one is degraded or failed, and answers with the last lines of the pods that restart or are not ready. The coding agent of Edit with AI gets neither
- **MCP: The Project In One Call**: `project_overview` returns the environments, the frontends and backends of each domain with the version each environment runs, the latest version each backend built, and the maintenance agents. The MCP instructions point agents to the new tools

### Changed

- **Starter Questions To Begin With**: the starter questions of the assistant drawn outside a section include where to start, how to create a new agent and how to create an app, and no longer how to connect an S3 bucket, which only the **Storages** page suggests
- **The Overview Of A Container Without A Configuration Tab**: the overview of a backend, and of a DOCKER frontend, no longer has a **Configuration** tab. **Summary** shows, under the **Version per environment**, the port with the URLs the container answers at in each environment, its docs and OpenAPI spec opened from there; **Resources** opens on the replicas, CPU and memory of each environment as chips, those an environment sets apart marked **Custom**; the log level of each environment, as chips marked the same way, sits above the logs, or in **Summary** when there is no **Logs** tab. The environment names of the **Version per environment** tiles are as tall as the production badge, so the versions line up
- **The Overview Of A Frontend In Tabs**: the overview of a frontend splits into tabs, the one open in the URL (`?tab=`), as that of a backend. A DOCKER frontend has those of a backend, **Summary**, **Resources** with its config maps, secrets and declared variables, and, once Argo CD is initialized, **Logs** and **Injected variables**; a BUNDLE one **Summary**, **Release** with its canary and published versions, and **Hosting**
- **The Environment Open In The URL**: the **Environments** page keeps the environment open in the URL (`?env=<slug>`, `?env=new` while creating one), so a link opens it. The namespace moves to **General**, shown once Argo CD is initialized; **Exposure** and **Network access** become one **Exposure and network** tab; the **Not production** chip is gone, and the log level and log format fields line up
- **The Technology Of A Backend On The Deployments Page**: the cards of the backends of a deployment show the logo of their technology beside the name, as those of the frontends do. The deployment records no stack for a backend, so the logo is that of the backend as it is now, none once it is deleted
- **Container Frontends Without Their Badge**: the DOCKER frontends listed in their own section of the **Backends** page no longer carry the Docker badge, which the section already says
- **The Overview Of A Domain In Tabs**: the overview of a domain splits into tabs, the one open in the URL (`?tab=`), as those of a frontend and of a backend: **Summary** with its frontends and backends and the AI tokens it spent, **Deployments** with the versions deployed in each environment, **Resources** with those its backends attach, and, when a backend or a DOCKER frontend runs in it, **Logs**

### Fixed

- **The Assistant Knows Who Asks And What Day It Is**: the console context of each question carries the user's id and email, today's date in the browser's time zone and the zone itself, so "how many tokens did I use this month?" no longer makes the assistant ask for an email or a date. `user_ai_usage` reads the usage of whoever calls when neither `userId` nor `email` is passed
- **MCP Waits Stop With Their Client**: `build_wait` and `deployment_wait` stop as soon as the client cancels the call or disconnects, instead of polling up to 240 seconds for nobody
- **Probes And Log Level Aligned**: the liveness probe fields sit in the left column and the readiness ones in the right, in the settings of a backend and of a project; the label of the log level of a backend sits on the line of its chips

## [14.0.0] - 2026-11-01

### Added

- **Live Preview Of A Backend**: the header of a backend has the **Live preview** button too, as those of a frontend and of a domain: it starts the backend alone from its default branch in an OpenShell sandbox and opens on its docs path, else on its root. `POST /api/live-previews` takes `kind: "backend"`; a backend without a connected repository is refused (`OPENSHELL_PREVIEW_NO_BACKEND`)

### Changed

- **The Screens Of A Card As Icons**: the cards of the **Domains**, **Frontends** and **Backends** pages open Edit with AI, the overview and the settings from a row of buttons equally wide, each with its icon alone and its name in the tooltip and to screen readers, instead of a full-width button and two labelled ones. On a frontend and on a backend a fourth one clones the repository, the popover with the HTTPS and SSH commands and the VS Code and IntelliJ links, which the card of a backend had not; a card without Edit with AI or without a repository has one fewer. The cards no longer show the slug under the name nor the name of the repository, the card of a domain no longer counts its frontends and backends but shows the logos of their technologies beside its name, as the card of a frontend or a backend shows its own, the card of a backend no longer repeats its technology in a badge, as its logo already shows it, and the cards of frontends and backends no longer show a version, which each environment runs its own of. The headers of the pages of a domain, a frontend and a backend leave out the slug too, and those of a frontend and a backend the version. In the header and the overview of a frontend or a backend, the name of the repository opens the popover that clones it, as the cards do, and the popover opens the repository on its provider too, where clicking its name led before. The tables of the **Backends** and **Frontends** pages have the buttons of the cards in a column of their own, where that of the frontends had **Clone repo**, **Build** and **Edit with AI**, and leave out the version; that of the backends shows the slug in place of the runtime and leaves out the repository name, the logo of the technology beside the name. The grids of the **Domains** and **Backends** pages end with a tile that creates one, as that of the **Frontends** page does, and the nodes of the flow view of the **Frontends** page leave out the version too
- **The Overview Of A Container, Reordered**: the overview of a backend, and of a DOCKER frontend, opens on the **Version per environment**, one tile per environment with the version it runs written large and the replicas it runs there, instead of a line among the settings. **Configuration** keeps how the container runs, its port, exposure, docs and OpenAPI paths, each with a button that copies it, log level, replicas, resources per environment and URLs, and no longer lists its probes, its image repository nor its default CPU and memory, which its settings still edit. Its config maps, secrets and declared environment variables, each in a card of its own, move to **Resources**, beside the resources it uses, which are only shown there and no longer detached from it, as its settings do, and the **Code repository** card is gone: the header links to the repository and clones it
- **Build And Deploy Of A Frontend Or A Backend Alone**: in the header of a frontend or a backend, **Build and deploy** builds its repository alone, then deploys its domain, where the others keep the version they run; its menu builds it alone too, and no longer offers the deploy of the domain. The separate **Build** button is gone from the header. The build and the build and deploy of a domain take `member`, `{ kind, id }` of one of its frontends or backends, to limit themselves to it: one outside the domain is not found (`DOMAIN_BUILD_MEMBER_NOT_FOUND`)
- **Replicas, CPU And Memory In A Card Of Their Own**: the **Runtime** tab of the settings of a backend, and of a DOCKER frontend, opens on a **Replicas, CPU and memory** card, apart from the runtime and the endpoint, with the replicas first, on a row of their own, and first in each environment set apart too
- **New Change Always Orange In Edit With AI**: the **New change** button of Edit with AI is orange even while a new change is open; the **3D workshop** keeps the whole width, with the queue under the scene, and from 1280 px it shows the new change or the work picked beside the scene, which stays in sight while it scrolls. A card with nothing left in its body leaves no blank band above the buttons
- **Apps, Not Only Frontends, In A Ready Project**: the screen of a project just set up says to start adding frontends and backends and to deploy your apps, instead of only frontends
- **A Version Per Environment For A Bundle Frontend**: a BUNDLE frontend serves in each environment the bundle that environment sets, in its **Version per environment** fields, which suggest the published versions, instead of its one **Version** in every environment; an environment that sets none no longer serves it from its next deploy. A release sets its version in the environment of the release, and promoting the versions of an environment brings those of the BUNDLE frontends too. Its overview opens on the version of each environment, and its published versions highlight those some environment serves. The version of a frontend is no longer required to create a BUNDLE one, and is never served as it is. Each environment of an existing BUNDLE frontend gets, once, the bundle it serves now, else its version
- **Live Preview Only With OpenShell Online**: the **Live preview** button of the header of a domain and of a frontend shows only while the OpenShell gateway is online, as the **AI sandbox** card of the organization settings reports it, instead of failing to start the preview when the gateway is down, degraded or not configured
- **Logs And Injected Variables Only With Argo CD Initialized**: the **Logs** and **Injected variables** tabs of the overview of a backend, the logs of the overview of a DOCKER frontend and of a domain, and the injected variables of the runtime settings of a DOCKER frontend show only once Argo CD is initialized for the project, instead of a card asking to initialize it or one that could not read the pod
- **A Template Library Per Kind**: opened from the **Frontends** page the templates library offers frontend templates and frameworks only, and a new backend starts from a library of its own. The framework of a saved frontend is chosen by hand in its settings, and detection no longer overwrites it
- **Starter Questions Of Vega Drawn At Random**: the questions Vega suggests in an empty conversation are three drawn at random, those of the section open first, among questions each answered by one list or one search of the docs, so a click costs few tokens; they change from page to page and in a new conversation

### Fixed

- **The Console Runs Locally Again**: the backend started with `pnpm dev` no longer stops on the test files beside its plugins and controllers, and `.env.example` sets `NODE_ENV=local`, so the routes answer where the proxy of Vite sends them instead of a 401 on every call
- **The New Template Button Keeps Its Width**: in the sandbox templates of the installation, the button that adds one no longer shrinks beside a long description

### Removed

- **The Versions In The Settings Of A Domain**: the **Versions** card of the details and settings of a domain, which set by hand the version of each of its frontends and backends, is gone; each one sets its own, per environment
- **The Deployed Versions Of The Domains**: the page of the versions each domain runs in each environment, opened from **Deployed versions** on the **Domains** page, is gone with its button; the versions of one domain stay in its overview, and `GET /api/domains/deployments` still answers

## [13.5.0] - 2026-11-01

### Added

- **The Log Level Of One Application**: a backend, a DOCKER frontend or a maintenance agent may set a **Log level** of its own, in the **Logs** box of its runtime settings or as `logLevel` of `backend_update`, `frontend_update` and `maintenance_agent_update`, to look into it alone without raising the one of the whole environment. It is handed as `LOG_LEVEL` in every environment instead of the environment's, from the next deploy, and in a live preview too; left on **The environment's**, each environment gives its own as before

### Fixed

- **The Live Preview Stays While The Agent Works On A Follow-Up**: in a conversation of Edit with AI, sending a new message emptied the **Live preview** box, which said the previews would appear once the development servers were ready, for the 20 to 30 seconds the new message took to report them again, on the same URL, as they never stopped in the sandbox. The preview of the previous messages now stays on screen until the new one reports its own, and the changes keep reaching it as they are made. It reloads once as each message ends, so a development server without hot reload shows them too
- **Two Conversations Of A Shared Sandbox No Longer See Each Other's Preview**: the conversations of a domain share a sandbox, and the preview of each frontend asked for port 5173. Two starting together both found it free; Vite, refused it, took the next port, while the preview was waited for and exposed on 5173, and showed the code of the other conversation. The preview of a frontend now asks for a port of its own in each conversation, between 10000 and 29999, as does the gateway of a domain previewed whole instead of 8000, and Vite is started with `--strictPort`, so it stops instead of moving. A backend keeps its own port, and a preview file its `port`
- **The Preview URL Field Shows No Example As A Value**: on the **Installation** page, with `OPENSHELL_PREVIEW_URL` unset, the **Preview URL** field showed `https://*.sandbox.example.com` as its placeholder, which read as a value already set. It is now empty, and its help says what to type

## [13.4.0] - 2026-11-01

### Added

- **Gradle In The Sandboxes**: a repository with `build.gradle` or `build.gradle.kts` and no `gradlew` is checked with `gradle build --no-daemon -q` when the image of the sandbox has Gradle, as one without `mvnw` is with `mvn`; before, it was not checked at all. The default `OPENSHELL_REGISTRY_HOSTS` take `services.gradle.org`, `github.com` and `release-assets.githubusercontent.com`, where the Gradle wrapper downloads its distribution, so `./gradlew` works in a sandbox; a list of your own must add them. The policy changes with them, so warm sandboxes made before are replaced
- **The Variables Of An Environment In A Live Preview**: a live preview opened on a frontend or a domain hands the development server of each frontend and backend what its container gets in the first environment that is not production, the one furthest back: the values of its config maps, secrets and resources there, then `LOG_LEVEL`, `LOG_JSON` and `ENVIRONMENT`. The URLs of the services of the cluster are left out, as from a sandbox they reach nothing: the previews started still find each other. The install and the commands of the coding agent never get them
- **The Previews Open On The URL Of The Installation**: behind an ingress the gateway of OpenShell returns the URL of a preview with the scheme and the port it binds, on its own domain (`http://<preview>.openshell.localhost:8080`), which the browser cannot open. `OPENSHELL_PREVIEW_URL`, or **Preview URL** in the sandbox settings of the **Installation** page, sets where the browser reaches them, `*` standing for each one (`https://*.sandbox.example.com`): the preview opens there. Unset, the URL of the gateway is kept

### Changed

- **The Logs Of A Sandbox Are Followed When Opened**: on the **Installation** page the log dialog of a sandbox opens with **Follow** on, reading the gateway again every 5 seconds while it stays open; it can still be turned off. The logs of the applications stay off until asked
- **The Languages Of A Template With Their Logos**: on the **Installation** page the languages of each template, in the list and in its form, show the logo of Node.js, Java, Python, Go and .NET

### Fixed

- **A Gateway That Refuses The Templates Says Why**: when the identity of the installation lacks the role a template needs on the workspace of the gateway (admin, to manage them), listing, saving and deleting a template answered a 500; they now answer 403 `SANDBOX_GATEWAY_FORBIDDEN` with what the gateway says, the command that grants the role included, and the page shows it
- **A Live Preview Installs The Design System Of The Project**: a live preview opened from the console wrote into the sandbox the `.npmrc` of the frontend's own design system only, so a frontend building with the one of its project or organization installed from the public registry, and failed on its private package (`ERR_PNPM_TARBALL_HTTP_STATUS` 404, then `vite: not found`). It now takes the design system that applies, as the coding agent does
- **The Emails Carry The Brand Of The Installation**: with `INSTALLATION_NAME` or `INSTALLATION_LOGO_URL` set, the emails of the console (activation, password reset, invitations, API key expiry, AI job ended) still showed Flightroom's logo and named Flightroom; they now show the name and the logo the console shows. A logo given as a path served by the console is reached at `FRONTEND_URL`. The sender stays `EMAIL_SMTP_FROM`

## [13.3.0] - 2026-11-01

### Added

- **A Sandbox Template Per Language**: on the **Installation** page each workload template of the gateway says which languages its image holds (Node.js, Java, Python, Go, .NET), shown as a column of the list and stored on the gateway as one label each, `languages.flightroom.dev/<language>: "true"`. A new sandbox of the coding agent is created from the template holding every language it needs: Node.js for a frontend, the runtime of a backend, and for the sandbox of a domain those of every repository of the domain. The template in use is kept when it holds them all, so the warm sandboxes serve it; otherwise the one with the fewest languages. With none holding them all, or none naming a language, sandboxes are created as before. The API takes `languages` on `/api/installation/sandbox-templates`
- **The Technology Of A Backend**: its page has a **Technology** field, also when it is created without a template: a language (Node.js, Python, Java, Go, .NET) or a framework that brings its language with it (Express, NestJS, Fastify, FastAPI, Flask, Django, Spring Boot, Quarkus, Micronaut, Gin, ASP.NET Core). A backend imported from a repository no longer stays without a runtime. A technology chosen by hand is kept as the user's (`stack.source: MANUAL`); a template chosen at creation still sets it. A stack sent through the API with a framework and no runtime gets the framework's
- **Revealing The Secrets Of A Running Container**: in the variables tab of a backend or a DOCKER frontend, the injected variables read from the running pod show the values of its secrets in clear on request, instead of their names only. Argo CD masks every Secret, so they are read from the Secret manifests the deploy committed to the configuration repository, at the revision Argo CD synced the environment to. Only an owner or a member of the project, or an administrator of its organization, can: a viewer and any API key are refused, and each reveal is logged. The API is `?reveal=true` on the container environment

## [13.2.0] - 2026-11-01

### Added

- **The Sandbox Variables In The Helm Chart**: `values.yaml` documents `INSTALLATION_ADMINS` and every `OPENSHELL_*` variable of the coding agent's sandboxes under `env`, with their defaults, and the gateway credentials `OPENSHELL_TOKEN` and `OPENSHELL_OIDC_CLIENT_SECRET` under `envSecrets`. Left empty they are not set, as before, so an upgrade changes nothing until they are filled in
- **Sandbox Templates From The Installation Page**: the **Installation** page lists the workload templates of the OpenShell gateway (name, image, CPU, memory, labels, which one new sandboxes use) and creates, edits and deletes them, instead of `apply-templates.py` on the gateway. They stay stored on the gateway, shared by every installation on its workspace. The gateway has no update, so an edit deletes the template and creates it again, putting the previous one back if the gateway refuses the new one; settings this page does not show (runtime class, GPU, service level) are kept. Editing the template in use lets the warm sandboxes go, so the pool refills from the new one; deleting it is refused. The **Template** setting becomes a list of the gateway's templates. Changes are audited (`sandbox_template_created`, `sandbox_template_updated`, `sandbox_template_deleted`), and the API is `/api/installation/sandbox-templates`
- **Live Preview Of Any Stack And Of A Whole Domain**: a repository previews from `.flightroom/preview.json`, `{ "prepare": "...", "start": "...", "port": 8080 }`, when its stack is not recognized or is to be previewed otherwise: `prepare` runs to the end first, `start` gets `PORT`, `HTTP_PORT` and `HOST`. The live preview of a domain starts its backends first and hands every development server the others as `<SLUG>_URL`, as the `services.flightroom` ConfigMap does in an environment; with backends exposed under a path, it opens on a gateway in the sandbox that routes each path to its backend, the path stripped, and the rest to the frontend, as the host of an environment does. A backend of a stack not recognized and without the file is left out instead of stopping the preview
- **What A Running Script Prints, While It Runs**: the progress of the coding agent shows the output of a running command (an install, a build) as it comes, instead of nothing until it ends: the sandbox streams it, the end of it is kept masked on the job and its request, written every 2 seconds and gone at the next event, so a long install no longer looks stuck

### Changed

- **One Log Viewer For The Applications And The Sandboxes**: the logs of a sandbox on the **Installation** page open in the same viewer as the logs of backends, Docker frontends, maintenance agents and domains: 100 to 2000 lines to read (the API now takes up to 2000), a filter, **Follow** (read again every 5 seconds, newest line in sight), off until asked as for the applications, JSON lines formatted and a download. The viewer now comes from `@flightroom/design-system` 2.3.0 (`LogViewer`, `LogViewerActions`, `LogLine`), so both pages share one component; typing in the filter no longer redraws every line

### Fixed

- **Live Previews That Never Started**: a live preview opened from the console did not install the dependencies of a Node.js repository, so its development server never started; with pnpm or yarn the host and port of the preview reached the server after a `--` it ignored. Every stack now prepares before it starts: the install (only when `node_modules` is missing), `pip install`, a Maven or Gradle compile, `go build`, `dotnet build`. The server is waited for up to 180 seconds instead of 30, with node, python3 or bash, so an image without Node.js can preview too; one that stops fails at once, with the last 30 lines of its log
- **The Running Script's Output Shows Its Newest Lines**: while the coding agent runs a script, its output box scrolls to the newest line instead of staying on the oldest, a progress bar shows its last frame only, a credential cut by the start of the box is masked like the others, and screen readers no longer read the whole output again at each refresh
- **The Logs Of One Sandbox At A Time**: on the **Installation** page, the logs of a sandbox no longer show those of the sandbox opened before while they load, a gateway line whose message is JSON is formatted, and a character printed across two pieces of output is no longer garbled
- **The Installation Page Opens In The Same Tab**: the **Installation** link at the bottom of the sidebar opened the page in a new tab, as the links to the documentation do; it now navigates in the console like every other entry
- **No Flash On The Installation Page**: the settings, the pool and the list of sandboxes no longer blink every 20–30 seconds while they refresh, and an edit being typed in the settings form is no longer lost at each refresh
- **No Kind Chip On The Map Cards Of A Deployment**: the config map and secret cards of a deployment no longer repeat their kind in a chip, as the section they are in already names it

## [13.1.0] - 2026-11-01

### Added

- **Installation Page For The Sandboxes Of The Coding Agent**: a user whose email is in the new `INSTALLATION_ADMINS` (comma separated, any case; unset, nobody) sees **Installation** at the bottom of the sidebar. Its page changes for the whole installation the idle minutes, the maximum age, the sharing, the live previews, the warm sandboxes, the image, the template, the registry hosts and the network executables of the OpenShell sandboxes: a field left empty keeps its environment variable's value, every replica applies a change within 30 seconds, and the image, template and network fields warn that they decide what the sandbox may reach and apply to new sandboxes only. It also shows the gateway, the pool and every sandbox of this installation, never another one's, with what it serves (domain, project, conversation or live preview), its organization, whether it is used and its age; the last 500 lines of the log of each one, credentials masked; and a button that deletes one after a confirmation that says when a job is using it. Saving and deleting are audited (`sandbox_settings_updated`, `sandbox_deleted`). The API is under `/api/installation`, for console sessions only, and the profile says `installationAdmin`
- **Warm Sandboxes**: `OPENSHELL_SANDBOX_WARM` (0 by default), or the installation page, keeps that many sandboxes created and unassigned, so a new conversation does not wait for its image to be pulled. A sandbox let go goes back into the pool while it lacks one, emptied of the folders and dev servers of its conversations but with the caches of its home, and only ever to the organization it last served; one past its maximum age, or created with another image, template or network policy, is deleted instead. Its time in the pool is billed to nobody. Sandboxes get random names, and what each one serves is kept in the database; those made before keep going as they did

- **The URLs Of The Backends And Frontends For Every Container**: each deploy writes in the namespace of the environment a ConfigMap `services.flightroom` with the URL every backend and DOCKER frontend deployed there answers on inside the cluster, named after its slug in uppercase with dashes as underscores: `orders-be` is `ORDERS_BE_URL=http://orders-be`. One with no version in the environment is left out. Every backend, DOCKER frontend and maintenance agent takes it first of its `envFrom`, so a config map of the team setting the same name points it elsewhere; it is written even empty, as every container names it. The configuration repository holds it as `<environment>/services.yaml`. `container_environment_get` and the runtime tab list its variables as `configMap services.flightroom`, a backend that declares one no longer sees it missing, and the MCP instructions and the Edit with AI agent tell agents to call other backends and frontends through them
- **`ENVIRONMENT` For Every Container**: each deploy hands every backend, DOCKER frontend and maintenance agent `ENVIRONMENT`, the slug of the environment it runs in, next to `LOG_LEVEL` and `LOG_JSON`. Like them it wins over a config map of the same name, and a resource can no longer set it. `container_environment_get`, the MCP instructions and the Edit with AI agent name it; the containers get it at their next deploy
- **Revealing The Values Of A Secret**: in the variables tab of a backend, each attached secret has a **Show values** button that shows its values in clear, per environment, until **Hide values**. Only an owner or a member of the project, or an administrator of its organization, sees them: a viewer keeps the keys only and an API key is refused whatever its role. The API answers at `GET /api/secrets/:id/values`, and each reveal is logged with the secret and the user
- **Config Maps And Secrets As Cards In The Deployments**: a deployment shows its config maps and its secrets as cards, like its resources, each with its kind, its name and how many keys it set; a click anywhere on a card opens the map
- **What Deleting A Map Leaves Behind**: with GitOps on, the dialog that deletes a config map or a secret says it stays in the configuration repository and in the cluster until the next deploy of each environment; for a secret, also that its values stay in the history of the repository, base64 encoded and not encrypted, and should be rotated if they were sensitive

### Changed

- **One Sandbox Per Domain For The Edit With AI Agent**: the conversations of a domain share an OpenShell sandbox instead of creating one each: a request on a domain uses that domain's, one on single frontends or backends the domain they are all in, anything else the project's. Each conversation keeps its copies, logs and previews in a folder of its own, so requests running side by side never touch each other's files, while the caches of npm, pnpm, Maven and pip are shared and an install another conversation already did downloads almost nothing. The sweep removes the folder of a conversation once it is idle and stops its dev servers; a preview takes a free port when another conversation holds its own. A sandbox past `OPENSHELL_SANDBOX_MAX_HOURS` (24) is deleted at the first sweep that finds none of its jobs waiting or running. The lifetime of a shared sandbox counts against its project and domain, no longer against the job that created it. `OPENSHELL_SANDBOX_SHARING=conversation` goes back to one sandbox per conversation; size the sandbox template for several conversations at once

### Fixed

- **One Job Of A Conversation At A Time**: a follow-up is refused while any job of the same conversation still waits or runs, not only a follow-up of the same job: following up an earlier message while a later one was still at work ran two agents on the same copies
- **No Refused Connection On Every Request**: nginx reaches the backend at `127.0.0.1:3000` instead of `localhost:3000`, which it tried first over IPv6, where the backend does not listen: every request logged a `connect() failed (111: Connection refused)` error and a warning before going through over IPv4
- **No `injected env (0) from .env` At Startup**: the backend reads its `.env` file once, quietly, instead of four times with a line each
- **No Mongoose Deprecation Warning**: the updates that return the updated document ask for it with `returnDocument: "after"` instead of the deprecated `new: true`

## [13.0.0] - 2026-11-01

### Changed

- **BREAKING — `EXPOSURE_URL` Of A Container Is Now `PUBLIC_URL`**: the public URL a backend and a DOCKER frontend are exposed at, origin of the environment and exposure path without a trailing slash, reaches the container as `PUBLIC_URL`. The value and when it is set do not change. `EXPOSURE_URL` is no longer set: code reading it must read `PUBLIC_URL`, and the containers get it at their next deploy. The MCP instructions, `container_environment_get`, the runtime tab and the Edit with AI agent name the new variable

## [12.1.0] - 2026-11-01

### Added

- **Injected Variables Of The Running Container In The Runtime Tab**: the runtime tab of a backend and of a DOCKER frontend lists, for the environment chosen, the variables its running container got, read through Argo CD from the live manifest of one of its pods, a running one first: its `env` (`HTTP_PORT`, `LOG_LEVEL`, `LOG_JSON`, `EXPOSURE_URL`, OpenTelemetry), then what the config maps, secrets and resources of its `envFrom` hold in the cluster, read through the Application of the environment, each with its source and, when another source sets the same name and wins, which one. Of a secret and a resource only the names are shown, as Argo CD hides their values. It names the pod and when its container started: a config map changed since reaches it at its next restart. A viewer does not see it, as with the logs. The API answers at `GET /api/backends/:id/environments/:environmentId/variables` and `GET /api/frontends/:id/environments/:environmentId/variables`; `container_environment_get` keeps telling what the next deploy hands the container
- **Environments In Tabs**: the environments page keeps the environments in a row, in promotion order from left to right with an arrow between them, each with its name, slug and production badge (the host is in the header of the editor, not repeated on every card). The editor below sits on the page background and is split into tabs from the design system (General, Exposure, Network access, Logs, Scheduled shutdown, Danger zone) instead of one long page, each section in a white card with its title on the left and its fields on the right, the help of each field under it. A dot on a tab marks unsaved changes or fields to fix, a save with an error opens the tab that holds it, and deleting the environment moves to the Danger zone tab. Exposure shows the subdomain between `https://` and the domain of the project and holds the host page domains; Logs sets the level from a list coloured as the log lines and the format as a JSON / Text choice
- **Add My IP**: the Network access tab adds the address the browser reaches the console from to the IP allowlist in one click, read by the backend at `GET /api/environments/client-ip`
- **Filters On The Resources List**: the resources list filters by type and by the backend that attaches each resource, beside the search

### Changed

- **A Config Map Or A Secret Needs At Least One Key**: one without keys is refused by the console, the API and the MCP tools (`VARIABLE_MAP_ENTRIES_EMPTY`); `config_map_create` now requires `entries`. The search of the config maps list also matches their values (a secret's stay masked, so only its keys)
- **Variables Of A Backend In Their Own Tab**: the environment variables, config maps, secrets and resources of a backend move out of the runtime tab into a Variables tab, as on a maintenance agent; the variables its running container received sit in an overview tab after the logs
- **Domain And Frontend Cards**: a domain card opens Edit with AI, its overview and its settings instead of editing in a dialog and deleting; a frontend card drops the build and keeps the clone of its repository, on a row of its own

### Fixed

- **Cancel In The Environment Editor**: after any change, Cancel restored the values but left the form marked as changed, with Update still enabled: the fields saved empty started from no value and the form compared different from its starting point

## [12.0.0] - 2026-11-01

### Changed

- **BREAKING — `FRONTEND_URL` Of A Container Is Now `EXPOSURE_URL`, Its Own Public URL**: every backend and DOCKER frontend gets `EXPOSURE_URL`, the origin of the environment followed by the path that container is exposed at, without a trailing slash. A backend no longer gets the URL of the frontend calling it, or the origin alone when none or several did: a backend exposed on its own, such as one serving its own pages, had a URL where nothing served them. A container without an exposure path, or a project exposed on no domain, gets none. `FRONTEND_URL` is no longer set: code reading it must read `EXPOSURE_URL`, and the containers get it at their next deploy. The MCP instructions, `container_environment_get` and the Edit with AI agent name the new variable

## [11.8.0] - 2026-10-31

### Added

- **Shell Commands For Edit With AI**: with an OpenShell gateway the agent gets `run_command` beside `run_script`, which runs any shell command in the sandbox, at the root of a repository or in a folder of it, for up to 10 minutes: the build and tests of a repository without a `package.json` (Maven, Gradle, Go, .NET, Python), one test file, a tool the scripts do not run. What it changes in the repository joins the change as for a script, counted in the 500 KB the agent may write, and the output of both, as the agent reads it, has the usual credential shapes masked. It does not get the `.npmrc` of the design system, which stays with `run_script`
- **Sandbox Time In The AI Usage**: the AI usage cards count, by Edit with AI, missions and live previews, the scripts and commands run in a sandbox and how long they ran, and how long each sandbox lived, idle minutes included until it is deleted. Shown in minutes once there is some, beside the tokens; the API returns it as `sandbox` on each summary and on each project of the organization's
- **Missions Apart In The AI Usage**: the tokens of the jobs of a mission are counted as `mission`, apart from those of Edit with AI, from now on
- **Edit With AI Reads The Console**: the agent of Edit with AI and of missions gets the read tools of the MCP server, run as the user the job runs for (whoever started it, or asked for the follow-up) and bound to its project: the CI runs and the logs of a failed one, the pods of each container with their logs, the environment variables a container gets, and the project's environments, domains, components, versions, config maps and variables. It diagnoses a failing build or a crashing container before changing code, and writes in the summary what the console needs changed, as it cannot change it. The tools holding or reaching credentials (secrets, storages, databases, repository connections), those of no use to a code change (AI usage of members, canary users, templates, dependency and integration plans...) and every write are left out. Every result reaches the model marked as untrusted data, credential shapes masked and only its end kept, and each call is audited in the log
- **The Environment Of A Container**: the MCP tool `container_environment_get` returns the environment variables the container of a backend or a DOCKER frontend gets in an environment, built by the same function the deploy writes its values with: each with its source (platform, config map, secret or resource), the source that wins when two set the same name (`env` over `envFrom`, a later `envFrom` over an earlier one), and the values of secrets and resources masked, only their length shown. `state` says whether it is what the next deploy hands the container, whether the environment leaves it out of its deploys, or the project deploys no container through GitOps; `missing` lists the variables a backend declares that nothing sets
- **Why A Container Stopped**: the pods of `application_pods_list` carry, in `containerDetails`, each container's CPU and memory requests and limits, its restarts, its current state with its reason (`CrashLoopBackOff`...) and how its previous run ended (`OOMKilled`, exit code), read from the live manifest of each pod through Argo CD, five at a time. The console's page of the pods, which polls them, does not read them
- **Vega Supervises Edit With AI**: the console assistant delegates code changes to the Edit with AI agent and follows it, with tools only it has, never in the MCP catalog: `agent_run_start` (a job on a domain, on chosen frontends and backends or on every one of the project, with a brief carrying the evidence it gathered), `agent_run_status` (summary, steps, commands with their exit codes, files with lines added and removed, tokens, cost and sandbox time; a file's diff only when asked, cut at 20,000 characters), `agent_run_wait` (up to a minute), `agent_run_follow_up`, `agent_run_stop`, `agent_run_apply` (a pull request per repository, confirmed, or a direct push to the base branches, destructive: the card says what goes where), `agent_run_discard` (confirmed) and `mission_start` (confirmed). They act as the user of the conversation, with their permissions and limits, and only on the agents that conversation started (`assistantConversationId`): at most 3 at work at once per conversation, a mission counting as its jobs at work, and 6 started, 3 follow-ups of a chain among them, before the user writes again. Every question carries the `conversationId` of the panel
- **Vega Answers When Its Agents End**: when a job or a mission of a conversation ends, the server adds a note to the conversation (ids, statuses and counts) and runs a turn of the assistant on its own, saved like the others, so the outcome is reviewed with the chat closed; the chat shows it live or when the user comes back. Such a turn reads, follows up and stops its own agents, parks what needs a confirmation for the user (a day), and refuses every other write, starting agents and missions included, to propose it instead; it never takes up a question the user got no answer to, uses the AI of the user's last question at effort `high` at most, counts its tokens as any answer, and at most 5 of them run between two questions. Turns of a conversation never overlap: each holds a lease renewed while it runs, and no turn runs past 10 minutes; a question asked during an update turn gets `ASSISTANT_CONVERSATION_BUSY`. The update runs once the browser has saved the turn before it (2 minutes at most), only the note is added while an action of the conversation waits for the user, and it is claimed once across replicas. The sweep of the server catches the agents that died or ended unheard, 3 conversations at a time
- **Agent Cards And Conversation Cost**: in the assistant chat, each job the conversation started has a card (status, repositories, files changed, tokens, cost, sandbox time) that opens its review, each mission one that opens its page, and the cost of the conversation is shown split and summed: the assistant's answers, the agents' tokens and their sandbox time. `GET /assistant/conversations/:id/agent-runs` returns them; a save of the conversation keeps the messages the server added, guarded on a version, and is refused with `ASSISTANT_CONVERSATION_CONFLICT` rather than written over them

- **Probe Timings**: each backend, DOCKER frontend and maintenance agent of kind container sets the initial delay and the period of its liveness probe and of its readiness probe apart, in whole seconds (a delay from 0, a period from 1, up to 3600): a container that starts slowly is no longer restarted before it is up. In the forms next to each probe path, in the API and in the MCP tools as `livenessInitialDelaySeconds`, `livenessPeriodSeconds`, `readinessInitialDelaySeconds` and `readinessPeriodSeconds`; left blank, the template of the project, else 30 seconds. The chart takes the period of each probe from the values: `templates/deployment.yaml` and `values.yaml` of `microservice-chart` are rewritten on a branch where they are still as Flightroom wrote them, a chart changed by the team is left alone and keeps a period of 30 seconds
- **Probe Templates Of A Project**: the settings of a project hold a probe template for its backends and one for its frontends, with the liveness and readiness paths and the four timings: the backends and the maintenance agents of kind container follow the backend one, the DOCKER frontends the frontend one, and each one overrides any field by setting it. Applied by the next deploy of each environment. The API and the MCP tool `project_update` take `probes.backend` and `probes.frontend`, each replaced as a whole, `null` removing it
- **Replicas In The Deployments**: the deployment cards show the replicas of each container, and a container stopped at 0 replicas is greyed out, without its URL

### Changed

- **The Assistant Drives Only Its Own Agents**: the console-only tools `ai_change_start`, `ai_change_apply`, `ai_change_open_pull_request`, `ai_change_discard`, `ai_job_start`, `ai_job_follow_up` and `ai_job_apply` are removed: the assistant starts, follows up, applies and discards agents with the `agent_run_*` tools, linked to the conversation and bounded by its limits, and still reads every AI change and job. Confirmation cards are worded by the console in the user's language
- **A Build Before Finish For Every Stack**: a repository changed by the agent with no `build` script in `package.json` must now have run, before `finish`, the check command of the files at its root: `mvn -B -q verify` (or `./mvnw`), `./gradlew build --no-daemon -q`, `go build ./... && go vet ./...` or `dotnet build`, when the sandbox image has its toolchain: the default image has Node.js only. Run is enough, not passed, as for the build script. Code a script or a command other than the build changes afterwards has to be built again

- **Probe Paths Left Out Follow The Project**: a backend, a DOCKER frontend or a maintenance agent created without probe paths no longer stores `/health/live` and `/health/ready`: it inherits them from the probe template of the project, and a path cleared in the form or sent as `null` goes back to inheriting. Those stored before keep their paths as their own. A DOCKER frontend with no probe path, which had no probes, is now probed on the paths of the template, `/health/live` and `/health/ready` by default

### Security

- **Pods And Logs Within The Domains Of A Member**: a member scoped to some domains reads the pods and the logs of the backends, frontends and maintenance agents of those domains only, in the console, through MCP and for their AI jobs; before, any application of the project. A slug a backend, a container frontend and a maintenance agent share is readable only when every one of them is in their domains
- **Connection Strings Masked In Every Scheme**: the credentials in a URL are blanked in build logs, in what the coding agent runs and reads, and in what the models answer whatever the scheme (`mongodb`, `mongodb+srv`, `postgres`, `mysql`, `redis` with a password only, `amqp`...), not only for `http` and `https`

## [11.7.0] - 2026-10-31

### Added

- **Overview Of A Backend In Tabs**: the overview of a backend is split into the **Summary**, **Configuration**, **Resources** and **Logs** tabs, in place of one long page

### Changed

- **kube-green Hours For Each Day Of The Week**: the scheduled sleep of an environment is set day by day, from Monday, in place of one rule for every day: each day is awake from when it wakes up to when it goes to sleep (from or until midnight when left empty), or asleep all day; Monday to Friday 08:00 to 20:00 and the weekend asleep until set. A SleepInfo has one set of days for both its times and wakes up only what it put to sleep, so `<environment>/sleepinfo.yaml` now holds a SleepInfo per sleep within a day: a night asleep is woken at 23:59 and put back to sleep at 00:00, and its pods start for that minute. The API and the MCP tool `environment_update` take `kubeGreen.days`, one entry per day with `weekday`, `awake`, `wakeUpAt` and `sleepAt`, in place of `weekdays`, `sleepAt` and `wakeUpAt`. A schedule saved before is turned into a day each at boot: its days awake between its two times, the others asleep. With no wake up time it no longer sleeps until the next deploy: its days are awake from midnight. The SleepInfos take new names, so the first deploy prunes the old one: an environment asleep at that moment stays scaled down until its next deploy

## [11.6.0] - 2026-10-31

### Added

- **A Value For All Environments In Config Maps And Secrets**: each key takes a value every environment gets, and an environment overrides it with its own where it needs one; with neither the key stays unset there, as before. The table of a backend shows the value an environment inherits in grey. The API and the MCP tools take it as `value` on each entry, beside the overrides in `values`. Keys saved before keep their values per environment, now overrides

## [11.5.0] - 2026-10-31

### Added

- **Detach A Config Map Or A Secret From Its Page**: each backend, DOCKER frontend or maintenance agent listed under **Used by** has a button that detaches the map from it; from its next deploy it no longer receives the values. The card now lists the DOCKER frontends and the maintenance agents too, which already kept a map from being deleted without showing up there
- **Subscription And Resource Group Of An Azure Storage**: a `storage` resource on Azure, in every variant, takes its subscription ID and resource group, both optional, passed in `STORAGE_<NAME>_SUBSCRIPTION_ID` and `STORAGE_<NAME>_RESOURCE_GROUP` to a backend that manages the account through Azure Resource Manager

### Changed

- **MongoDB Database Name Variable**: the database of a `mongodb` resource is passed in `MONGO_<NAME>_DATABASE_NAME` in place of `MONGO_<NAME>_NAME`, in both variants. The old name is no longer set: a backend that reads it must switch to the new one, and gets it at its next deploy

### Security

- **Unused `@tailwindcss/typography` Removed**: it pinned `postcss-selector-parser` 6.0.10, vulnerable to quadratic selector parsing (CVE-2026-104844, GHSA-rj75-hqrm-r3gf), and nothing in the console loaded it

## [11.4.1] - 2026-10-31

### Changed

- **Days Of A kube-green Schedule As Buttons**: the days an environment sleeps are picked from a row of day buttons, Monday first, in place of typing them in cron notation; the API and the MCP tools still take and return the cron string, e.g. `1-5`. The time zone suggests the IANA zones while typing
- **Deleting A Production Environment Asks For Its Name**: an environment marked as production is deleted only after typing its name
- **Environment Editor**: the slug of a new environment follows its name, e.g. `STAGING-EU` from "Staging EU", until it is typed by hand, and once created a note says it cannot change. **Allowed Domains** is now **Host page domains**, under General, and says what it is for: the domains of the pages that load the frontends of the environment, whose requests are attributed to it. **Update** shows its progress and stays off until something changes. The reorder hint and handles are hidden while there is a single environment

### Fixed

- **Environment Selector Up To Date**: creating, renaming or deleting an environment updates the environment selector of the console right away, and saving no longer switches the selected environment back to the first one; deleting the last one shows the setup screen again
- **Unsaved Changes Of An Environment**: opening another environment, or a new one, while the open one has unsaved changes asks before discarding them
- **Reordering Environments With The Keyboard**: the handle of a tile also moves with the left and right arrows and keeps the focus, and the order is saved once the moves stop, not at every key press with a notification each
- **Environment Setup Screen**: the preset groups can be picked with the keyboard and their colours no longer make the environment names unreadable; while one environment is being edited the actions of the others are off, the first one included, and confirming an edit reads Update rather than Add

## [11.4.0] - 2026-10-31

### Added

- **Scheduled Sleep With kube-green**: an environment can sleep off hours on a [kube-green](https://kube-green.dev) schedule, set in the new kube-green section of its editor: the days in cron notation (`1-5` until set), when it sleeps and wakes up in a time zone (20:00 to 08:00, `Europe/Rome` until set; no wake up time, it sleeps until its next deploy), whether Deployments, StatefulSets and CronJobs are suspended, and the backends and frontends that never sleep. With GitOps on, the next deploy commits it as `<environment>/sleepinfo.yaml`, a SleepInfo in the namespace of the environment, and prunes it once the schedule is turned off. The tile of a sleeping environment shows the kube-green logo. The cluster needs the kube-green operator: without it the SleepInfo does nothing. The API and the MCP tool `environment_update` take `kubeGreen`, which replaces the saved schedule as a whole
- **Manage Environments From The Deployments Page**: a **Manage environments** button among the actions of the Deployments page opens the Environments page

### Fixed

- **Scaling, Promoting And Domain Releases No Longer Fail**: scaling the replicas of an environment, promoting versions to it and setting the versions of a domain release failed with "Cannot pass an array to query updates", as Mongoose 9 refuses an aggregation pipeline as an update without the `updatePipeline` option

## [11.3.0] - 2026-10-31

### Added

- **Logging And Frontend URL For Every Container**: each deploy hands every backend, DOCKER frontend and maintenance agent `LOG_LEVEL` and `LOG_JSON`, set on the environment: a **Log level** among `trace`, `debug`, `info`, `warn`, `error` and `fatal` (`info` until set) and a **JSON logs** switch (`true` until set), in the environment dialog while GitOps is on. A backend and a DOCKER frontend also get `FRONTEND_URL`, the origin of the environment followed by an exposure path: a DOCKER frontend its own, a backend the one of the exposed frontend that calls it, the origin alone when several or none do; none while the project is exposed on no domain. They are written in the `env` of each values file, which the chart already reads, so no chart changes, and they win over a config map of the same name; a resource can no longer set them. The API and the MCP tool `environment_update` take `logLevel` and `logJson`; the MCP instructions and the coding agent tell agents to configure the logger and the links to the frontend from them
- **Application Insights**: telemetry to an Azure Monitor Application Insights resource you own, nothing sent without a connection string. A resource of type **Application Insights** sets `APPLICATIONINSIGHTS_CONNECTION_STRING` on the backends attaching it, under that exact name whatever the resource is called, as the Azure Monitor distros read it by themselves. Every deploy hands each container `OTEL_SERVICE_NAME` (its slug) and `OTEL_RESOURCE_ATTRIBUTES` (`deployment.environment` and `service.version`), so each application is a node of its own in the Application Map; a resource can no longer set them. The console sends its own backend and browser telemetry when `APPLICATIONINSIGHTS_CONNECTION_STRING` is set on the installation, also in the Helm values. See `docs/APPLICATION-INSIGHTS.md`

### Changed

- **Environments As Tiles**: the Environments page lists the environments as tiles, dragged to reorder, and edits the selected one in a panel below them, its fields grouped in General, Exposure and Logs, in place of the table and its dialog. Deleting an environment is done from its panel

## [11.2.0] - 2026-10-31

### Added

- **Scale Replicas Of An Environment**: the Deployments page sets the pods of every container an environment runs at once, e.g. 0 to stop UAT for the night and back to 1 in the morning. The dialog takes the environment and the number, from 0 to 20, and lists each backend, DOCKER frontend and maintenance agent of kind CONTAINER deployed there with the replicas it runs now and the ones it would get; a JOB runs no pod and is left out. Save writes the replicas of that environment, its CPU and memory kept; Save and deploy deploys it right after. A domain-scoped member scales only the applications of their domains, a viewer none. The API takes it as `GET /environments/:id/replicas` for the preview and `POST /environments/:id/replicas` with `{ replicas }`; the MCP tools as `environment_replicas_set`, which does not deploy

### Changed

- **Replicas Go Down To Zero**: a backend, a DOCKER frontend and a maintenance agent of kind CONTAINER can run 0 pods, for the container or in one environment only, e.g. none in UAT; the range is now 0 to 20. With 0 the Deployment stays and runs no pod, and its route or ingress is left out. A 0 set in an environment wins over the container's, it is not taken for unset. The API and the MCP tools take `replicas: 0`

## [11.1.0] - 2026-10-31

### Added

- **Pull Requests Between Existing Branches**: the assistant and MCP clients open a pull request (a merge request on GitLab) from one branch of the repository of a frontend or a backend to another, e.g. `release/dev` into `main`, with the `pull_request_create` tool; the target is the default branch when left out. Nothing is pushed and nothing is merged: the merge stays at the provider, behind its reviews and branch policies. The assistant asks the user first, and a viewer cannot do it. When the provider refuses, e.g. there is nothing to merge or one is already open, the tool says why
- **Replicas**: a backend, a DOCKER frontend and a maintenance agent of kind CONTAINER set how many pods run them, from 1 to 20, in the runtime settings next to the CPU and memory; left empty, the chart runs one. Each environment can set its own too, e.g. more in production, in the same per-environment box as the CPU and memory. The deploy writes `replicas` in the values file of each environment: what it sets, else the container's, else 1. A JOB still runs none. The API and the MCP tools take `replicas`, and `replicas` in each entry of `environmentResources`

### Changed

- **An Applications Repository Already Registered In Argo CD Is Used As It Is**: the initialization no longer stops on an applications repository that Argo CD holds a global registration of, made by hand, by an earlier version or by a project of another organization. It reads through that registration, as Argo CD does for every AppProject anyway, and never changes nor deletes it. Still refused are a registration of it scoped to an AppProject, and any registration of the configuration repository, which holds the secrets. A registration is told apart by its URL as Argo CD compares them, case, a trailing slash and `.git` aside, so the project's own written otherwise is no longer taken for someone else's, nor deleted right after its upsert. See `docs/ARGOCD.md`

### Fixed

- **The Deploy Overlay Says Why Argo CD Got No Application**: when the deploy could not hand Argo CD the ApplicationSets, e.g. a project still on the 10.x names of Argo CD that asks to be initialized again, the overlay waited for ever with no word. The applications left without an Application now fail the rollout, and the overlay shows the reason, translated, as the Argo CD settings do. A domain release fails at once instead of at its timeout. An alignment that failed only for other environments does not fail this one
- **The Deploy Overlay Ends On The Applications It Shows**: one the deploy did not touch, still on the revision before, no longer keeps it waiting with every card green. The rollout asks Argo CD to read the repository again, at most every 30 seconds per application, when the refresh after the commit came before Argo CD saw it
- **A Version Whose Tag Already Exists Is Refused First**: retrying a version a canceled run had already tagged answered the raw `staleOldObjectId` of Azure DevOps. The build checks the tag first and answers `BUILD_TAG_EXISTS`, translated in the console

## [11.0.0] - 2026-10-30

### Added

- **Azure AI Speech And Azure Service Bus Resources**: `speech` and `serviceBus` join the resource catalog. A speech resource takes its region and an optional language, and authenticates by its key or by an Entra ID app or the managed identity of the pod on its custom subdomain endpoint. A Service Bus takes its namespace, by connection string, Entra ID app or managed identity, with an optional queue, topic and subscription. The agent is told to use the official SDK of each with the variables of the variant
- **Installation Theme**: the console loads `/theme.css` in its `<head>`, empty in Flightroom. Mount a stylesheet of your own over `/var/www/frontend/theme.css` to restyle the console: it overrides the CSS variables of the design system, colours for the light and the dark mode, corner radius and font, before the first paint. nginx serves it to be revalidated at every load. See `docs/THEMES.md`
- **CPU And Memory Per Environment**: a backend, a DOCKER frontend and a maintenance agent can set their CPU and memory requests and limits apart in some environments, e.g. more in production. Under the CPU and memory of the runtime settings, each environment added gets the four fields, every one left empty being the value of the container. The deploy writes in the values file of each environment what it sets, else the container's, else the chart's default; a request above its limit is refused per environment too. The API and the MCP tools take it as `environmentResources: [{ environmentId, cpuRequest, cpuLimit, memoryRequest, memoryLimit }]`, replaced as a whole. Deleting an environment drops what was set for it
- **Version Per Environment**: a backend, a DOCKER frontend and a maintenance agent run, in each environment, the version set for it, e.g. the latest in development and an older one in production. An environment without one does not get them: its deploys leave them out, and a maintenance agent cannot be run there. The version of the container is now only the latest the CI registered, or one set by hand, and is not deployed by itself; a domain release sets the version it built in the environment it deploys. The release settings show a field per environment, left empty where it is not deployed. The deploy of an environment tags the image in its values file with its version and records it in the deployment, so the rollout and the build status show what runs there. The API and the MCP tools take it as `environmentVersions: [{ environmentId, version }]`, replaced as a whole. Deleting an environment drops the version set for it. At the first start, the applications made before get, in every environment, the version its current deployment recorded, else their version: what they ran stays deployed
- **Promote Versions**: the Deployments page brings to an environment the versions another runs, e.g. from development to UAT or from UAT to production. The dialog lists each backend, DOCKER frontend and maintenance agent with the version it runs in the target and the one it would get, all those that change picked to start with; one not deployed in the source keeps what it runs in the target. Save writes the version per environment, which the next deploy applies; Save and deploy deploys the target right after. A domain-scoped member promotes only the applications of their domains, a viewer none. The API takes it as `GET /environments/:id/promotion?from=<id>` for the preview and `POST /environments/:id/promotion` with `{ from, applications?: [{ kind, _id }] }`; the MCP tools as `environment_promotion_preview` and `environment_promote`, which does not deploy

### Changed

- **BREAKING — Argo CD Objects Start With `fr-` Again**: since 10.0.0 the AppProject, ApplicationSets and Applications were named `<project slug>-<parts>-<hash>`, which the `mfe-*` rules of the documented `argocd-rbac-cm` no longer matched. They are now `fr-<project slug>-<parts>-<hash>`, and the documented policy and the setup snippet in Settings grant `fr-*` and `fr-*/*`. The next initialization of a project moves its 10.x objects to the new names: the old ApplicationSets are deleted without cascade, so the workloads stay, and the old AppProject is deleted after them. Before upgrading, add the `fr-*` rules to `argocd-rbac-cm` and keep the current ones until every project has been initialized again; until then alignment asks for an initialization. The Gateway keeps its name, and so do the Helm releases. See `docs/ARGOCD.md`
- **Docs Brought In Line With The Code**: the README, the Helm chart README, the docs under `docs/`, the workflows and e2e READMEs, the agent instruction files and `SECURITY.md` no longer describe defaults, routes, tools, limits and versions that had changed. `pnpm format` works again: turbo had no `format` task
- **The Deploy Overlay Lists What The Deploy Updated**: the rollout marks each application whose version or image the deploy changed, and the overlay lists those only, all of them when no version changed. The list scrolls on its own
- **A Lighter Console To Load**: the Auth0 SDK and MSAL are downloaded only where their login is configured, and both start as soon as the configuration names them; the Markdown renderer of the assistant, the project wizard, and the replay and feedback of Sentry left the initial payload; React and the router sit in a vendor chunk that a release does not change. The container forms re-render only the field that reads a value
- **npm Registry Answers Cached By Outcome**: a package found is cached for an hour, a 404 for five minutes, and a registry out of reach (timeout, network error, 5xx) for a minute, so a firewalled registry no longer costs 10 s per package on every dependency report; a 401 or 403 is not cached. Lookups of the same package at once share one request

### Removed

- **Redirects Of Old URLs**: `/services`, `/service/*`, `/organization-users`, the older `?tab=` of the frontend and backend forms and of the AI workspace, and the tabs merged into another one no longer redirect. A form tab opens from its hash only
- **Boot Migrations Every Installation Has Run**: the moves to the Frontend and Backend names, of the projects to organizations, of the legacy canary types and of the inline variables of the backends to maps, the expiry index of the assistant conversations and the conversation backfill of the AI change requests no longer run at boot. The encryption of the credentials stored in the clear stays, since `SECRETS_ENCRYPTION_KEY` can be turned on later
- **Argo CD Objects Of Versions Before 10.1**: the objects labelled `mfe-orchestrator`, the ApplicationSets per environment and the configuration Applications made by the console are no longer recognised, except an AppProject still labelled `mfe-orchestrator`, which the move to the `fr-` names reads

### Fixed

- **Settings Reloading In A Loop**: the settings of a container, the version per environment and the environments gate no longer refetch and remount forever
- **GitHub**: the branch picker lists every branch, not the first 100; files over 1 MB are read, from the blob of the sha first answered; a path holding `#` or `?` reads and writes the right file; the repository secrets of an organization are addressed under `/repos`; the logs of a failed run that downloaded are kept when another fails, and each one left out is logged
- **GitLab**: the branch picker pages through every branch; the job logs that downloaded are kept when another fails, and each one left out is logged
- **Azure DevOps**: every project is listed, following the continuation token, and the variable groups too; a token refused with the sign-in page (203 or HTML) is a 401, where tags, pushes and file reads took it for a success; the build logs that downloaded are kept when another fails
- **Argo CD Cleanup During An Initialization**: an Application or ApplicationSet already gone when deleted is no longer a failure, an Application is deleted in its AppProject, so Argo CD answers 404 rather than 403, and a repository with an empty AppProject is deleted as the global one it is
- **Storage-Hosted Frontend Files**: a file missing from its storage answers 404 instead of 500, while a missing bucket or container stays a 500 that alerts; a stream is uploaded to Azure Blob Storage in blocks, where it threw
- **Scaffolding Temp Folders**: a template scaffold that fails before its commit removes its temporary folder
- **npm Packages With No Concurrency**: a dependency report resolves its packages with at least one worker whatever the concurrency configured

### Security

- **Registration Closed When `REGISTRATION_ALLOWED` Is Off**: the flag only hid the Register link; `POST /api/users/registration` now answers `403 REGISTRATION_NOT_ALLOWED` unless both `REGISTRATION_ALLOWED` and `ALLOW_EMBEDDED_LOGIN` are on. Invitations, the first SSO login and the first-startup registration are unaffected
- **`GOOGLE_AUTH_HOSTED_DOMAIN` Enforced**: the variable was served to the console and applied nowhere. When set, a Google login whose account has no `hd` claim, or another one, is refused, and the console passes the domain to Google as a hint
- **AI Model Keys Encrypted At Boot**: the boot migration that encrypts the credentials stored before `SECRETS_ENCRYPTION_KEY` was set now covers the `apiKey` and `secretAccessKey` of the AI models too
- **One GitHub Deploy Key Per Repository**: the check of the deploy secret went to `/repos/undefined/<repo>`, so every call minted a new system deploy key and replaced the secret, leaving the previous keys valid. It now checks the repository the secret is written to
- **Storage Details Out Of Serve Errors**: a file missing from a storage answered anonymous callers of the serve URLs with the provider message, which for Google Cloud Storage names the bucket and the path of the object: it now says `File not found`. A Google service account key that is not JSON no longer quotes part of its private key in the error

## [10.1.0] - 2026-10-29

### Added

- **Initialize The Pipeline Templates Repository**: the Initialize button in the pipeline templates of a connection writes into the repository picked, on its ref and under its folder, one folder per `<type>/<compiler>` of the templates library and per `<type>/<language>` (every backend language, `javascript` for the frontends), each with an empty pipeline of the connection's provider: `.github/workflows/build.yml`, `.gitlab-ci.yml` or `azure-pipelines.yml`. One commit, pushed without forcing and signed by the user; a folder that already has a pipeline is left as it is, and the setting is not saved. Until completed, an empty pipeline is copied as it is into the repositories scaffolded through the connection

### Changed

- **No Provider Folders In The Pipeline Templates Of A Connection**: a connection serves one provider, so the pipeline templates repository picked on it no longer holds one folder per provider: each folder, `<type>/<compiler>/<template slug>`, `<type>/<compiler>` or `<type>/<language>`, holds what goes at the root of the new repository, `.github/`, `.gitlab-ci.yml` or `azure-pipelines.yml`, e.g. `service/docker/azure-pipelines.yml`. A repository still laid out as `<type>/<compiler>/<provider>/` is no longer read. The official `template-pipelines` keep their layout

## [10.0.0] - 2026-10-29

### Added

- **Voice Mode For Vega**: the microphone button next to the question talks with the assistant: what the user says is sent when they stop talking, the answer, asked short and spoken, without lists, code or ids, is read aloud and the microphone opens again. It uses the browser's speech recognition and synthesis, so it shows in Chrome, Edge and Safari, and Chrome and Edge send the audio to their vendor's speech service
- **Pipeline Templates From A Folder**: the pipeline templates repository of a code repository connection can be read from a folder, such as `ci/templates`, set in the pipeline templates of the connection or through `code_repository_pipelines_set`: the layout `<type>/<compiler>/<provider>` starts there, and from the root when it is left empty. A folder the repository does not have stops the scaffold before anything is created, as a missing ref does

### Changed

- **Pipeline Templates Per Connection**: the repository the pipelines of a scaffolded frontend or backend are copied from is set on each code repository connection, from its row in Code repositories, instead of once for the project: a repository created through a connection gets the pipeline templates of a repository that connection reaches, and a connection without any uses the official `template-pipelines`. `project_pipelines_set` is replaced by `code_repository_pipelines_set`, which takes the connection to configure
- **Slug Named After The Repository**: a frontend or a backend created with a new repository from Maestro or through `frontend_scaffold` and `backend_scaffold` takes the name of its repository as its slug, `checkout-fe` or `orders-be`. The tools take the `repositoryName` and no longer a slug of their own, and refuse a name that is not a slug or does not end in `-fe` for a frontend or in `-be` for a backend
- **Images Scanned With Trivy**: the CI scans both Docker images, standard and all-in-one, before pushing them, and stops the release on a CRITICAL or HIGH vulnerability that has a fix. A finding to accept goes in `.trivyignore`, with its reason and an expiry
- **Smaller Standard Image**: the standard image installs only the production dependencies of the backend, from the workspace lockfile, and no longer ships npm, pnpm and the pnpm store: 112 MB, was about 680 MB
- **Dependencies Updated**: every library to its latest release, among them the Anthropic SDK 1.x, Biome 2.6 and three 0.186

### Fixed

- **Backend Starts With Production Dependencies Only**: `yaml`, read at runtime by the GitOps of config maps and secrets, was a development dependency, so the all-in-one image could not load it

## [9.3.0] - 2026-10-29

### Added

- **SharePoint Resource**: `sharepoint` joins the resource catalog and reaches a SharePoint Online site through Microsoft Graph by an Entra ID app, with a client secret or a certificate, or by the managed identity of the pod, with the site URL and an optional document library. The agent is told to resolve the site and the library through Graph with the variables of the variant
- **How Long A Job Took**: each AI job shows how long the agent worked, live while it works and not counting the wait in the queue
- **Delete A Failed Edit With AI Conversation**: a conversation that failed or was discarded, with nothing left to review nor applied, can be deleted from its queue by who started it or an organization administrator. The deletion is logical: its jobs are only marked deleted, and the tokens they spent stay counted in the AI usage
- **Maintenance Agents Read The Logs Of What They Maintain**: every deploy gives the container of a maintenance agent `FLIGHTROOM_API_URL` and `FLIGHTROOM_AGENT_TOKEN`, in a Secret `<slug>.flightroom` of the configuration repository. With that token the agent reads, through the console API, the pods and pod logs of the backends and container frontends it maintains, through Argo CD, and their latest builds with the logs of the failed jobs. Only its own targets, and only in the environment it runs in: the token of each environment is its own
- **Revoke The Tokens Of A Maintenance Agent**: the danger zone of a maintenance agent revokes the tokens its container reads logs and builds with, for when one leaves the configuration repository. They are refused at once, and the next deploy of each environment writes new ones
- **Logs Through MCP**: MCP clients and the console assistant read the pods of a backend, a container frontend or a maintenance agent and their logs through Argo CD (`application_pods_list`, `application_logs_get`, not for a viewer), the logs of the failed jobs of a CI run (`build_run_logs_get`), and revoke the tokens of a maintenance agent (`maintenance_agent_tokens_revoke`)
- **Stop A Domain Build And Deploy**: a build and deploy of a domain that is still running can be stopped from its dialog, after a confirmation. It ends where it stands and the console no longer takes it forward; what it did stays: the tags pushed, the CI runs they started, a deploy already committed
- **Micronaut Backend Template**: `service-micronaut` joins the backend templates, so a project whose backend technology is Micronaut gets one to scaffold from. Java 25 and Maven, port 8080, probes on `/health/liveness` and `/health/readiness`, OpenAPI on `/swagger/openapi.json`
- **Pipelines By Language**: the pipeline templates repository of a project can hold one pipeline per language, `<type>/<language>/<provider>/` with java, python or javascript, e.g. `service/java/azure_dev_ops/azure-pipelines.yml` for every Java backend. A folder of the template or of its compiler still wins over it
- **Design A Domain With A Wizard**: a new functional domain can be designed in a wizard, with or without an AI. With one, a short conversation asks what the application is called, what it does and where it is exposed (loaded by a host frontend, an application of its own, or no user interface), and proposes its frontends and backends with the gateway path of each backend; the user reviews the domain and the first request for the agent, then the scaffold dialog creates the components and starts the job. Without one, the same questions come step by step and a frontend and a backend named after the domain are proposed
- **Variable Keys Through MCP**: `backend_get` and `frontend_get` return `attachedVariables`, the environment variables the attached resources, config maps and secrets set on the container, keys only, so a coding agent knows what its code can read

### Changed

- **AI Jobs Run Side By Side**: a job clones its repositories into working copies of its own, so jobs on the same frontend or backend start at once instead of waiting for each other with "Waiting for the repository to be free". Their proposals meet only when applied: a file changed on the base branch by a proposal applied first stops the next apply with a conflict, as before. A project runs up to 5 jobs at once, was 3
- **Deployment Cards Show Only The Name**: the cards of the backends, frontends and resources of a deployment no longer repeat the slug nor list the keys of a resource

### Fixed

- **Azure DevOps Build Logs Of Another Repository**: the logs of a failed build are read only when the build is one of the repository of the frontend or backend asked about. Azure DevOps numbers builds across the whole Azure DevOps project, so a build number of another repository returned its logs
- **New Backends And Frontends Never Registered A Version**: the pipelines of the templates registered backend versions at `/services`, gone with the rename to backends, and read the deploy key as `MICROFRONTEND_ORCHESTRATOR_API_KEY` while the console stores it as `FLIGHTROOM_API_KEY`, so nothing built from a template could be deployed. The pipelines of the templates now register at `/backends` and read `FLIGHTROOM_API_KEY`
- **An Azure DevOps Pipeline Waiting For Permission**: the pipeline the console creates for a new Azure DevOps repository is permitted on the `MFE_ORCHESTRATOR_SECRETS` variable group, where its first run stopped until someone allowed it by hand. A repository created without a template gets its pipeline too, ready for the azure-pipelines.yml the team pushes
- **One Live Preview Per Conversation**: the AI workspace showed a live preview for every message of a conversation; it shows one
- **Microsoft Session Refused Before It Expires**: with a Microsoft account, calls failed with 401 between the expiry of the ID token and that of the access token. The ID token is now renewed five minutes ahead, and a session whose refresh token is gone goes back to the login page instead of staying with every call refused

## [9.2.0] - 2026-10-28

### Added

- **A Deploy Follows Argo CD Until The Containers Run**: a deploy no longer ends when its GitOps commit is pushed. The deploy overlay stays open and shows, for each backend and container frontend, whether Argo CD is waiting, syncing, progressing or healthy, with the pods while they start. Build and deploy gets a rolling out step that fails when Argo CD cannot apply, when a built member stays degraded past 2 minutes, or after 20 minutes. A redeploy, which commits nothing, is not followed

### Changed

- **A Domain Build Skips What Did Not Change**: the build and the build and deploy of a domain no longer tag a repository whose branch is still on the commit of the version its frontends and backends already have, so a change on the backend alone builds only the backend. The skipped ones show as unchanged and keep their version in the deploy
- **Language And Theme Live In The Profile**: the sidebar no longer holds the language and theme selectors, which move to a Preferences section of the profile page, nor the Contribute link
- **Status Badges Lead With A Dot**: the badges of builds, dependencies, missions, their repositories and AI changes show a dot in the colour of their status, pulsing while the work is running. They come from the design system, 2.1.0, with the picker of projects and organizations, the page layout and the loading and error states of the pages

### Fixed

- **Text Too Long For The AI Context**: the notes of a design system, its .npmrc and the AI context of a project, frontend, backend, resource, domain or maintenance agent stop at the length the server accepts, with a counter under the field, where a longer text was refused only on save
- **Notifications In The System Dark Theme**: the notifications went dark only when the dark theme was picked by hand, and stayed light with the system one. Switching theme no longer shows the last notification again
- **The Environment Dialog Fits The Screen**: the dialog of an environment stays within the viewport

---

## [9.1.0] - 2026-10-27

### Added

- **An Email When An AI Job Ends While You Are Away**: when a job on a frontend, a backend or a domain finishes or fails and whoever started it has not been seen in the console for 3 minutes, they get an email in their language, linking to the page of the job in its project. Jobs stopped by the user and jobs of a mission send nothing

### Changed

- **The Chart Version Is The Flightroom Version**: the Helm chart is versioned as the release it ships, so chart 9.1.0 runs Flightroom 9.1.0, where 9.0.0 came with chart 0.3.14. A `--version` or an Argo CD `targetRevision` pinned to a 0.3.x range has to move to the new numbers. The release workflow refuses a tag that is not the chart version
- **The API Key Expiry Email Points At Its Button**: the email asks to create a new key with the button below it and to replace the old one wherever it is used

### Fixed

- **A Tab Opened Across A Release**: nginx answered a hashed chunk a release had removed with index.html, without cache headers, so a tab opened before the release could keep failing on it. Missing assets now answer 404, index.html is revalidated at every load, and the app reloads once when a chunk fails to load
- **An Azure DevOps Tag The Provider Refused**: Azure DevOps answers 200 to an update of the refs it refused, so the build looked done and the build and deploy waited for a CI that never started. The tag now fails with the reason Azure DevOps gave

---

## [9.0.0] - 2026-10-27

### Breaking

- **The Deploy Secret Is Named `FLIGHTROOM_API_KEY`**: the API key Flightroom writes into GitHub, GitLab and Azure DevOps for the pipelines, and the official template-pipelines read, was `MICROFRONTEND_ORCHESTRATOR_API_KEY`. Pipelines already in the repositories keep reading the old name and keep working. A frontend or backend created from a template gets pipelines reading the new one, which a connection made before the rename does not have: edit the connection and save it once to have it written. A secret added by hand, or a project pipelines repository, has to move to the new name

### Added

- **Shape A New Project With The Assistant**: the new project wizard opens asking whether to describe the project to the assistant or set it up step by step. The assistant asks its questions until the draft covers the name, the environments and the functional domains, which get a step of their own in place of hosting
- **API Key Expiry Emails**: the owners of a project and the administrators of its organization get an email 30 days before an active API key of the project expires, and again 7 days before. The keys are checked every hour, and each notice goes out once even with several replicas
- **The Branch Of Each Member In A Domain Build**: the build and deploy dialog of a domain lists its frontends and backends with their repository, each with its own branch, plus one choice that sets them all: main everywhere, a branch they share, or each repository's default branch. The domain build takes `refs`, the branch of each member by id: a member left out is tagged on `ref`, main when that is left out too. Two members sharing a repository on different branches are refused, as the repository gets one tag. Each repository of the build tells the branch it was tagged on
- **The Builds Of A Domain Release**: the build and deploy dialog of a domain shows the builds still running and the ones that failed, with Vega waiting while they run
- **CPU And Memory Of Each Application**: backends, frontends built into an image and maintenance agents take a CPU request, a CPU limit, a memory request and a memory limit. The values file of the application carries only the ones set, and the chart fills in the others with its defaults. A request above its limit, counting the chart default for the side left blank, is refused, as Kubernetes would refuse the Deployment

### Changed

- **Deployments And Builds By Functional Domain**: a deployment shows a box per functional domain, with its name linking to the domain and its frontends and backends inside, two by two on wide screens; the build table gets a heading row per domain with its components below. The domains go by name and the members of none last; a project with no component in a domain keeps the single list
- **A Bigger Workshop In Edit With AI**: the Vegas off duty, whose work waits, thinks, has a proposal ready or failed, fly from spot to spot of an open deck in front of the bays and go back to their bay once the agent works on them again. The room has four bays to a row, grows a row past four Vegas and grows with the window up to 820 px. An applied work's Vega takes off with its rocket, a discarded one's sinks and fades away, and the queue of the classic view sits under the workshop, so applied and discarded works stay at hand
- **Vega In The Deploy Game**: Vega flies the deploy game and waits in the deploy pill
- **Home From The Logo**: the logo and the name at the top left of the sidebar link to the home page

### Fixed

- **A Sandbox That Never Became Ready**: a sandbox stuck provisioning was waited for again by every live preview of the domain, each failing after 300 seconds. It is now deleted and replaced, and the error names the phase it was left in

---

## [8.6.1] - 2026-10-27

### Changed

- **Edit With AI Opens On The Workshop**: the 3D workshop is the view Edit with AI opens on; whoever picks Classic keeps it, as the browser remembers the choice. The workshop takes the whole width, under a bar with New change and the switch of the view, where the classic view keeps its column with the queue

### Fixed

- **The Workshop On A Retina Screen**: the scene showed at the size of its drawing buffer, twice its box on a retina screen, so only a corner of the room was in sight
- **Live Previews That Take More Than A Minute To Start**: a live preview copies the repositories into a sandbox, installs them and starts their development servers before it answers, often for minutes; the nginx of the image gave up after its default 60 seconds with `504 Gateway Time-out`, and the console closed the preview tab. It now waits up to 15 minutes for `POST /api/live-previews`, in the standard and in the all-in-one image. A reverse proxy or load balancer in front of Flightroom needs its own timeout raised for that path too

---

## [8.6.0] - 2026-10-27

### Added

- **The Workshop Of Edit With AI**: a second look of Edit with AI, next to the classic queue, picked with Classic | 3D workshop and remembered by the browser. Every work of the queue is a Vega in its bay of a workshop floating in space, seen in isometric view: two walls of windows on the stars, pegboards of tools, a workbench, shelves of spare parts, a server rack, a welding arm, a gantry crane, and in each bay a console and a tool cart. The Vega moves as its work goes: it slides between its console and its editor while the agent writes code, loops the loop with its wrench while a script runs, circles its pad over a magnifying glass while the agent reads, hops with a proposal ready, spirals up while it is applied, and shudders, grey and smoking, when it failed. While a work runs, the last tool the agent called sets the move, read every 2 seconds. A click on a Vega, or on its plate under the deck, opens the work. Drag to turn the camera all the way round and tilt it, pinch or Ctrl/Cmd and the wheel to zoom. Up to 8 works at once, the running ones and the ones to review first; the classic view lists every work. Each work keeps its callsign and its colour. three.js loads only with the workshop, the scene stops out of sight, and with reduced motion the Vegas change pose without moving. A browser without WebGL is told to use the classic view

### Fixed

- **Files Changed By A Script In A Stable Order**: the files a script changed in Edit with AI are listed by path, where they came in the order of the sandbox's filesystem, so the same change reads the same every time

---

## [8.5.0] - 2026-10-27

### Added

- **Pod Logs Through Argo CD**: a Logs card on the overview of a backend and of a Docker frontend reads the last lines the pods of its Application wrote in an environment, through the Argo CD the project deploys with, with no access to the cluster. Pick the environment and the pod, how many lines, a filter, the container before the last restart, and follow to read them again every 5 seconds; download them as a file. A line the application logs as JSON reads as its level, colored, its message and its other fields, and opens on the whole object, indented: Format JSON turns it off, and the download keeps the lines as the pod wrote them. Only the pods alive now are there. Viewers do not see it, as logs may hold what the configuration hides. The Argo CD account of Flightroom needs `p, role:orchestrator, logs, get, mfe-*/*, allow`: add it to the role of an installation set up before
- **Logs On The Overview Of A Domain**: the same Logs card on the overview of a domain, with a picker of its backends and Docker frontends first. A static frontend has no pods, so no logs
- **Images In Edit With AI**: paste, drop or attach up to five images (PNG, JPEG, WebP or GIF) to a request and to its follow-ups, on a frontend, a backend or a domain. The console scales them down to 1568 px on the long edge and refuses one still over 2 MB, and the agent receives them as images on Anthropic, Azure AI Foundry, Amazon Bedrock, Azure OpenAI and Gemini. They are saved on the job, which expires with it, never in its transcript: a later turn only reads that images were attached. A model that does not read images fails the job with the provider's error. The assistant and the MCP tools stay text-only
- **Vega, The Mascot**: a small orange drone that shows how it feels with its light. It blasts off on the deploy screen, waits on the empty assistant, and sits in the middle of the Edit with AI composer, ready to code with its editor, picking up a wrench once the request is sent. Drawn in SVG with CSS animations, still when the system asks for reduced motion

### Changed

- **The Assistant Is Vega**: the console assistant, Maestro until now, is called Vega in the console and introduces itself so
- **Azure Pipelines Upload Task**: the generated Azure pipelines call the `flightroom-upload@1` task instead of `mfe-orchestrator-upload@1`, and the source of the Azure DevOps extension left this repository. Pipelines generated before keep the task they were written with

---

## [8.4.0] - 2026-10-26

### Added

- **OpenShell Status In The Organization**: the AI tab of the organization says whether the OpenShell gateway, where Edit with AI installs, builds and tests, is online, degraded, offline or not configured, with the version it reports. Every member sees it. The backend asks the gateway at most every 30 seconds per replica, gives up after 5 seconds, and logs why it is down rather than sending it to the browser
- **Cost Of The AI Tokens**: the AI tokens card shows what they cost next to the tokens, as a tile and as a column of the breakdown: in the resources of a project, by source, and in the AI of the organization, by project, as well as on a domain, a frontend and a backend, where a repository counts its share as it does the tokens. Only the usage of the AIs given their prices counts, with the cost recorded when it was spent: a price changed later does not rewrite the past. AIs priced in USD and in EUR show one amount per currency, never converted
- **Service Account By Provider**: a service account resource says whether it is Google or Microsoft. The JSON key becomes the Google variant and sets `SA_<NAME>_PROVIDER=google`. The new Microsoft variant is an Entra ID app: tenant, client id, client secret and an optional scope, with `SA_<NAME>_PROVIDER=microsoft`, and the backend gets its token from `login.microsoftonline.com/<tenant>`. Any other OAuth2 server stays on the client credentials variant, with its token URL. Saved resources keep their variant, but a Google key now adds `SA_<NAME>_PROVIDER` on the next deploy

### Fixed

- **Edit With AI On A Shared OpenShell Gateway**: two installations on the same gateway and workspace no longer delete each other's sandboxes, which stopped Edit with AI with `[not_found] sandbox not found` while it prepared a repository. The sweep of idle sandboxes took a conversation of the other installation, unknown in its own database, for an idle one. A sandbox now carries the label `flightroom.dev/owner`, the installation id, and its name includes it, and the sweep deletes only its own. Sandboxes made before carry no owner and go only once their conversation is known and idle. A script whose sandbox disappeared runs again once in a new one. Two installations restored from one database share the id: set `OPENSHELL_SANDBOX_OWNER` on each. Upgrade every installation on the gateway: an older one still deletes the others' sandboxes. The sandboxes of conversations open during the upgrade are created again under their new name; old ones of a preview or with no conversation are not swept, and can be deleted by hand (`flightroom.dev/role=ai-change` without `flightroom.dev/owner`)

---

## [8.3.0] - 2026-10-26

### Added

- **IP Allowlist Per Environment**: an environment takes the IP addresses and CIDR ranges its applications answer to (`ipAllowList`), set from its dialog and over MCP. With the project exposed on a domain, the deploy commits a Traefik `ipAllowList` Middleware next to the Gateway of the environment, and the HTTPRoute of each application goes through it: any other address gets `403`. Once set, the Middleware stays with the environment, and an emptied list opens it to every address, so a deploy of one domain changes the list for every application at once. The first time, deploy the whole environment: until then, the applications not deployed again answer every address. The chart template `httproute.yaml` of the applications is replaced on the next deploy when it is still as Flightroom wrote it; a template the team changed has to add the `ExtensionRef` filter itself. Traefik must see the real client address: see [EXPOSURE.md](docs/EXPOSURE.md)

### Fixed

- **Microsoft Login**: signing in with Microsoft finishes again. Since MSAL 5 the popup has to hand the response back to the console itself, and the console opened in it instead, so the login waited and timed out. The redirect URI is unchanged, so the app registration in Entra ID stays as it is

---

## [8.2.0] - 2026-10-26

### Added

- **AI Context Per Resource**: a resource takes a markdown context for AI agents, as projects and domains do. Edit with AI gives it to the agents working on the backends that attach the resource, tagged as the team's context. Set from the resource form and over MCP
- **Azure Cosmos DB Resource**: `cosmosdb` joins the resource catalog and reaches an Azure Cosmos DB account through its NoSQL API by account key, connection string, an Entra ID app or the managed identity of the pod, with endpoint, database and an optional container. The agent is told to use the official SDK with the variables of the variant
- **Domain Members From The Overview**: the overview of a domain lists the frontends and backends it groups. Add puts others of the project in it, moving one out of another domain, and a member can be taken out, staying in the project in no domain (`POST /domains/:id/members/remove`). Only who reaches the whole project changes them

---

## [8.1.2] - 2026-10-26

### Added

- **Open What A Deployment Deployed**: a deployment links to the frontends, backends, resources and variable maps it deployed

### Fixed

- **Repository Shared By Two Projects In Argo CD**: two projects of an organization linking the same repository, typically the applications one, could not both initialize Argo CD: it holds one registration per URL, and the second project was refused with `ARGOCD_REPOSITORY_CONFLICT`. The second project now reads through the global registration the first one made, with no credentials of its own and never deleting it, and the first one leaves it in place while another project reads through it. A registration made by hand or by a project of another organization is still refused

---

## [8.1.1] - 2026-10-26

### Changed

- **Bare Image Names In The Container Registry**: an image repository with no `/`, e.g. `bacheca-team-fe`, is deployed as `<containerRegistry>/<name>`, as an empty one is deployed as `<containerRegistry>/<slug>`; a full path is used as written. The form tells which image will be deployed

### Fixed

- **Argo CD Branches In Another Case**: Azure DevOps keeps the first spelling of a branch, so a deploy of `UAT` lands on an existing `uat`, while Argo CD resolves a revision by its exact name. An environment now finds its branch of the applications repository whatever the case, and the ApplicationSets point Argo CD at the branch as the repository names it
- **Empty ApplicationSets Explained**: an environment a deploy committed to that finds no branch in the applications repository was left out of the ApplicationSets in silence, which could then list no environment and make no Application. The Argo CD settings now name it, with the branches the console read (`ARGOCD_ENVIRONMENTS_WITHOUT_BRANCH`)

---

## [8.1.0] - 2026-10-26

### Added

- **Installation Name And Logo**: `INSTALLATION_NAME` and `INSTALLATION_LOGO_URL` replace the name and the logo of Flightroom in the sidebar, the login page, the new project wizard and the browser tab. Unset or empty, the console keeps its own. Shipped in the Helm chart `values.yaml`
- **Money Spent By Members**: the member list adds to the AI tokens of the month what they cost, one amount per currency, at the prices set on the AI models (`aiCostsSpent` on the members of `GET /projects/:id/users`). AIs without prices are not counted
- **Cost Chip**: the cost of an assistant answer, an Edit with AI job or a fleet mission stands out in a chip next to its tokens

### Changed

- **Labels Renamed To Flightroom**: what the console makes for Kubernetes and Argo CD is labelled `app.kubernetes.io/managed-by: flightroom`, and the Argo CD objects `flightroom/project-id`, `flightroom/environment`, `flightroom/application` and `flightroom/component`. Objects made by an earlier version keep the `mfe-orchestrator` labels until they are saved again: the console still recognizes them as its own, cleans them up and refreshes them, and prunes the GitOps files with the old `managed-by`. Label selectors or policies outside the console that match `mfe-orchestrator` must match `flightroom` too. The GitLab deploy token Argo CD reads with is named `flightroom-argocd`

### Fixed

- **Argo CD With Custom Namespaces**: an environment given a namespace after Argo CD was initialized was dropped in silence from the ApplicationSets of the applications, which came out empty. The other environments are still aligned, and the Argo CD settings now name the environments that wait for Argo CD to be initialized again (`ARGOCD_NAMESPACES_NOT_IN_PROJECT`)

---

## [7.0.0] - 2026-10-23

### Breaking

- **Service Becomes Backend**: the `Service` entity is now `Backend` across the API, the console, the MCP tools and the docs. The routes `/api/services...` become `/api/backends...`, the by-slug ones the CI calls included (version registration, deploy report); the MCP tools `service_*` and `services_list` become `backend_*` and `backends_list`, with `serviceId`/`serviceIds` arguments renamed `backendId`/`backendIds`; the import target `service` becomes `backend` (else `400 IMPORT_TARGET_INVALID`) and the `SERVICE_*` error codes become `BACKEND_*`. GitHub Actions, Azure tasks and external pipeline templates must move to the new routes. A startup migration renames the collections and the fields; if it fails, startup fails. The old console URLs `/services` and `/service/...` redirect

### Added

- **AI Token Limit Per Project Member**: a project owner or an organization administrator sets the input and output tokens each member may spend in the project per calendar month (UTC), assistant and Edit with AI together; empty for no limit, 0 turns AI off. Set from the Edit access dialog, `PUT /projects/:id/users/:userId` (`aiTokenLimit`) and the `project_member_role_set` MCP tool. Past it, assistant answers, AI jobs and missions are refused with `429 AI_TOKEN_LIMIT_REACHED`
- **Frontend Overview**: a frontend has the same three screens as a backend, Edit with AI, Overview and Details & settings; the read-only overview at `/frontend/:id/overview` shows its repository, AI usage, release and hosting, or for a Docker frontend its images, container configuration and variable maps
- **Detach A Resource**: the "Used by" list of a resource and the resources card of a backend detach it, so it can be taken away or deleted without opening every backend's settings. The domain overview lists the resources per backend
- **Build And Deploy From Frontends And Backends**: a frontend and a backend have the same actions as their domain, Build and deploy (the release of their domain, disabled without a domain) and Build (tags only their repository), in Edit with AI, and in the overview when Edit with AI is not available

### Changed

- **Domain Header Actions**: Build and deploy is always there, disabled until the environments load, next to Build, which only tags the repositories. The separate Deploy button and the backend Set release dialog are gone: a version is set in the settings
- **Compact Settings Of Frontends And Backends**: Domain and Release sit side by side at the top of General, the repository joins General and the variables join Runtime; the open tab is kept in the URL hash and old `#container`, `#variables` and `#repository` links open the tab that now holds them. The Port field explains `HTTP_PORT`
- **Resources List**: it no longer shows the number of variables of each resource
- **CI**: the release is published only for tags on `main`, and the standard and all-in-one images build in parallel with a BuildKit cache

### Fixed

- **Invitation Token Leak**: inviting a member, resending the invitation or changing its role answered with the membership document, invitation token included, which let an administrator take over an account that never signed in. These routes now answer with a membership view
- **Backends Map**: a second click on a galaxy opens the nearest backend instead of its domain

---

## [6.2.0] - 2026-10-23

### Added

- **Welcome To The First Project**: an organization with no projects opens on a screen that says it is ready and leads into the project wizard, instead of dropping the owner straight into it. A plain member with nothing shared yet still gets the empty picker, and a pending invitation still comes first

### Changed

- **The Initial Setup Creates The Organization, Not A Project**: the first-startup form asks for the organization name, and `POST /api/startup/registration` creates the first user and their organization only; the first project is created afterwards from the welcome screen. The route still accepts `project` from older clients, which then names the organization when `organization` is left out and is created as before, and answers `400 ORGANIZATION_NAME_REQUIRED` when neither is sent
- **Emails Render In Every Client And Speak The Recipient's Language**: activation, password reset and both invitations use a table-based layout with inlined CSS, a logo, a preheader, dark mode and a plain-text part. They follow the recipient's language (Italian or English, Italian for new users), name roles as the console does, and an invitation says who sent it

### Fixed

- **Email Titles**: the subject was never passed to the template, so every email had an empty `<title>`

---

## [6.1.0] - 2026-10-23

### Added

- **MongoDB Resources**: `mongodb` is a resource type of its own, prefix `MONGO`, instead of an engine hidden in `database`: by connection string (`MONGO_<NAME>_URL`, a `mongodb+srv://` URI, with an optional database name) or by host and credentials (port 27017, `authSource` defaulting to `admin`, replica set and TLS optional). `MONGODB` is no longer an option of the `database` engine
- **BigQuery Resources**: `bigquery`, prefix `BQ`, gives a service the project id and an optional dataset and location, authenticated with a service account JSON key (`BQ_<NAME>_CREDENTIALS_JSON`, kept encrypted) or with the identity of the pod (Application Default Credentials, e.g. GKE Workload Identity), which needs no credential. `BQ_<NAME>_AUTH` tells the client which of the two it is
- **Generic Resources**: `generic`, prefix `RES`, for whatever the catalog lacks: the resource defines its own variables in `customFields` (`[{ name, secret }]`, at most 100), each set as `<prefix>_<name>`, with one value for every environment and per-environment overrides like any other resource. Renaming or removing a variable drops its values, and turning a secret plain or a plain one secret drops the stored value, so a credential never comes back readable. The console edits the variables in the resource form; the MCP `resource_create` and `resource_update` tools take `customFields`

### Fixed

- **The Masked Placeholder Is Not A Value**: a plain variable sent back as the `••••` placeholder, as a client does after turning a secret plain, is refused with `RESOURCE_VALUE_INVALID` instead of being stored literally

---

## [6.0.0] - 2026-10-23

### Changed

- **The Helm Chart Is Now `flightroom`, Published On ghcr.io** (breaking): the chart moved from `helm/mfe-orchestrator` to `helm/flightroom` and every release pushes it to `oci://ghcr.io/flightroom/charts/flightroom`, so Helm and Argo CD install it without cloning the repository. Chart `0.3.0` defaults to `lory1990/flightroom` at the release tag instead of `lory1990/mfe-orchestrator:4.0.0`. The name is part of the Deployment selector and of every resource name, so upgrading an existing release recreates the resources and deletes the PVC of the uploaded bundles unless it is annotated `helm.sh/resource-policy=keep` and mounted back with `persistence.existingClaim`: the chart README has the steps. The release workflow fails when the chart `appVersion` is not the tag being released or the chart version is already published
- **One Pod Per ReadWriteOnce Volume**: the chart refuses to render `replicaCount > 1` or `autoscaling.enabled` on a volume without `ReadWriteMany`, where the second pod could never mount the claim, and switches such a deployment to the `Recreate` strategy unless `strategy.type` is set: the rolling update with `maxUnavailable: 0` hung whenever the new pod was scheduled on another node

- **One Endpoint, Shared By Every Environment**: the **Endpoint** card of a service and of a DOCKER frontend is now an **Expose** switch and a single exposure path, the same on the host of every environment, instead of a base URL typed per environment. Exposed, the path is required and the card previews the resulting URL in each environment (`https://<environment host><path>`, plain HTTP when the project has no certificate issuer); off, `exposurePath` is saved as `null` and the application gets no route. The service overview and the serve API derive the URL the same way, so the URL handed out for a DOCKER frontend follows its exposure path instead of a hand-written one
- **A DOCKER Frontend May Be Not Exposed**: like a service, it no longer needs an exposure path, through the console, the REST API and the MCP `frontend_create`, `frontend_scaffold` and `frontend_update` tools. A new DOCKER frontend still starts exposed in the console, since it is usually the shell

### Removed

- **Per-Environment `urls` Of Services And DOCKER Frontends**: the field is gone from the REST API, the MCP `service_*` and `frontend_*` tools and the GitOps values, which no longer carry an `ingress` block: the HTTPRoute of the exposure path covers it. Stored values are ignored
- **`DOCKER_FRONTEND_EXPOSURE_PATH_REQUIRED`**: the error is no longer raised

---

## [5.1.0] - 2026-10-22

### Changed

- **MFE Orchestrator Is Now Flightroom**: the product, the console, the emails, the MCP server and the AI assistant all carry the new name, and the links point to flightroom.dev, console.flightroom.dev and github.com/flightroom. The Docker image is published as `lory1990/flightroom`. Identifiers that existing installations depend on keep their old value: the database name, the `MFE_ORCHESTRATOR_HUB` hosting type, token salts and issuers, Kubernetes labels, the Helm chart name, the client SDK packages and the `MFE_ORCHESTRATOR_*` variables
- **New Palette And Icon**: the console follows `@flightroom/design-system` 2.0 (charcoal, pumpkin, sunglow, olivine, zomp). Status colours come from the new success, warning and info tokens instead of fixed Tailwind shades, every text/background pair meets WCAG AA in both themes, and the favicon and logo are the new control-room icon

### Security

- **The API No Longer Returns The Activation And Reset Tokens**: `toFrontendObject()` stripped the password and the salt but left `activateEmailToken` and `resetPasswordToken` in the object, so `POST /api/users/registration` — a public route — answered with the activation token it had just minted, and every other route that serialises a user did the same with the reset token whenever one was pending: login, profile, the organization and project invitation responses. Both are bearer credentials, and holding one activates the account or changes its password without ever reading the mailbox, which is the whole of what the email verification proves. Anybody could therefore register somebody else's address and activate it from the response body. The two tokens and their expiry dates are now deleted alongside the credentials, in the single method every user response goes through

### Fixed

- **The Password Reset No Longer Claims Success Without SMTP**: `requestPasswordReset()` was the only one of the three email flows that did not ask `canSendEmails()` first. It minted the token, saved it, and only then tried to reach a host that is not configured: the send failed after a credential valid for a full hour had already been written onto the account, where nobody could receive it. Registration and invitations have something to degrade into when SMTP is missing — an account that is simply active — this one has not, so it now refuses before writing anything, with the `EMAIL_NOT_CONFIGURED` business exception the invitation flows already raise. The screen was hiding the failure: it awaited `mutate()`, which returns `void` and swallows the rejection, so "check your email" and the redirect ran whatever the backend answered — for this error and for every other one. It uses `mutateAsync()` now. Business exceptions travel as `{ success: false, error: { code, message } }` while the API client only ever read `responseData.message`, so the toast would have shown the bare axios string: the page keys off the code through the new `errorCodeOf()` helper and translates it

---

## [4.0.0] - 2026-08-27

### Added

- **Organizations As The Tenant Of Projects**: A user can belong to several organizations, a project to only one. Whoever administers the organization (`OWNER`, `ADMIN`) reaches all of its projects, a plain member only the ones they were invited to: the rule lives in the single gate of `BaseAuthorizedService`, so every service inherits it without rewriting it. Inviting someone to a project brings them into the owning organization as a plain member — created already accepted, which avoids keeping two invitation tokens in sync — and that implicit membership is cleaned up when the invitation is declined or the member is removed from the project. Projects written before organizations get one at startup: one per owner, with their projects inside and the other members carried over with converted roles. It only looks at projects still without an organization, so it is safe on every boot and resumes an interrupted run on its own. Three endpoints that had no access control at all were closed along the way: inviting a collaborator, listing the members and resending a project invitation

- **Encryption At Rest For Storage And Repository Credentials**: With `SECRETS_ENCRYPTION_KEY` set (32 bytes, base64 or hex), the credentials the console keeps for a project are encrypted with AES-256-GCM before reaching Mongo: bucket keys, connection strings, service accounts, repository tokens. Whoever reads the database — a dump, a backup, a Mongo managed by someone else — sees only ciphertext. It does not protect against whoever controls the process: the backend must be able to decrypt to talk to S3 during an unattended deploy, so the key stays within reach of anyone holding the environment. The `v1` marker in the format is there to introduce a KMS-backed scheme later without rewriting the values. `storages.authConfig`, `coderepositories.accessToken/refreshToken` and the same fields inside `deployments` are covered — a deployment freezes a copy of the storages and the serve API reads the keys from there, so encrypting the `storages` collection alone would have left every past deployment's keys in the clear. Global variables stay in the clear on purpose: the platform serves them to every browser as `window.globalConfig`, and encrypting them would make them look protected without being so. With no key configured everything stays as before, with a warning at boot; a key of the wrong length stops startup; the migration that rewrites what is already stored is idempotent. See `docs/SECRETS.md`

- **Renaming A Project After Creation**: The settings page showed the name as static text — the mutation existed but was marked unused and the call was commented out, so the success toast appeared without saving anything. Name and description are now a form, modelled on `OrganizationDetailsSection`. Slug and id stay read-only because the slug is part of the path of the already-uploaded bundles. The new name is written into the store as well, otherwise the header and the switcher kept showing the old one. The invalidation key after deletion was wrong too: it was `["projects"]` while the listing lives on `["projects-mine", organizationId]`

- **Marketing Consent On The Profile Page**: The consent could only be given at registration, and the `PUT /api/users/marketing-consent` endpoint that changes it had no interface calling it. The profile page now carries the consent checkbox, showing the date it was given and clearing it on withdrawal, and appears only where `MARKETING_OPT_IN_ENABLED` is on — the same condition as the registration checkbox

### Changed

- **BREAKING — `PUT /api/projects/:projectId` Is Now Schema-Bound**: The route had no schema, so the body spread wrote whatever field the caller decided to send, `slug` among them: the slug is part of the path the already-uploaded bundles live in (`<slug>-<id>/<microfrontend>/<version>`), so changing it would have made them unreachable. The updatable fields are now taken one by one and the body is typed `ProjectUpdateInput`, which exposes neither `slug` nor `organizationId`. The response is no longer wrapped in `{ success: true, data }` — it was the only route in the backend doing that, and nobody read it that way while the client already typed it as `Project`

- **BREAKING — The API No Longer Returns Credentials**: A placeholder is returned in their place, and a field that comes back identical to the placeholder counts as "not retyped". The edit forms keep working as before; what changes is the Azure and GitLab connection test, which now sends the repository id instead of a token

- **Organization Moved From The Sidebar To The Header**: `/organization-users` sat in `mainNavItems` among the project entries, while the organization context already lives in the header with its switcher and its breadcrumb. The sidebar is now entirely about the project and the organization level has a single door: the header button, turned into a menu with settings, switching and creation. The breadcrumb name is clickable too. The route becomes `/organization`, which is what the page actually is — it carries name, description and danger zone besides the members — and the old path stays as a redirect so links and bookmarks keep working. The picker dialog is now controlled instead of hanging off a `DialogTrigger`, so "New organization" opens the form directly instead of going through the list

- **Microfrontend Form Layout**: Provider, repository and group say together where the code is but took three full rows in a wide card, and the hosting row in flex held only the two selects, leaving url and entry point below at full width, one row each. All of them now share their row and wrap only when they no longer fit. `SelectField`'s trigger does not receive `fullWidth` from the design system, so it stayed as wide as the chosen text — the form's selects now fill their column like the text fields

- **Fourteen More Components Come From The Design System**: `DangerZone` and `DangerZoneRemoveMicrofrontend` were two ~120-line files that were 95% character-identical, copy-pasted dead code included; the framed table with its tinted header row was rewritten in seven pages; eight section headings had drifted into three different weights and margins. `@mfe-orchestrator/design-system@1.5.0` adds `DangerZoneCard`, `ConfirmByTypingDialog`, `SearchInput`, `SectionHeader`, `AddTile`, `IconTile`, `Meter`, `ColorSwatch`, `StatTile`, `NumberedSteps`, `DescriptionList`, `CopyableValue` and `SelectControl`, plus a `loading` state on `Button` and `framed`/`scroll` on `Table`. Forty-three files lost a net 270 lines. Several fixes ride along: the typed confirmation in both danger zones never reset, so cancelling and reopening the dialog left the confirm button already unlocked; the numbered setup steps on the Azure and GitLab pages used raw palette colours with no dark-mode variant; one of the two canary progress bars carried no `role` or `aria-value*`; the search field in the repository import dialog was announcing the microfrontend dashboard's label; the five hand-written select labels were never associated with their control; the project id and slug in the settings page emitted a literal `false` CSS class and were never actually monospaced; and the `accent` icon tone resolved to a near-white violet, which made the api-keys icon almost invisible in light theme

- **Empty States, Code Blocks And Copy Buttons Come From The Design System**: The same three patterns were reimplemented at every call site, and had drifted apart — the empty blocks used seven different vertical paddings, five icon treatments and three text tokens for the same message, and the copy buttons disagreed on whether copying gives any feedback at all (the project id button showed none, the API key one showed a check that never reset). `@mfe-orchestrator/design-system@1.4.1` now provides `EmptyState`, `EmptyStateRow`, `CodeBlock` and `CopyButton`, and twenty-two call sites were moved onto them. The empty-state title is a real heading with a configurable level instead of bold text, the copy confirmation is announced through a live region rather than a silent icon swap, and the install and configuration snippets on the integration page can finally be copied. Some blocks change size slightly where the shared scale differs from what they had

- **Deployable Infrastructure Pinned To 4.0.0**: The Compose file, the Terraform module and the Helm chart named `2.3.0`, so a fresh installation came up two major versions behind — without the builds page, the canary strategies, the marketing opt-in, the organizations or the credential encryption. All three now name `4.0.0`, the chart version was bumped to `0.2.0`, and MongoDB and Redis are pinned to `mongo:8.0` and `redis:8-alpine` instead of floating on `latest` and `alpine`
- **Helm Values Aligned With The Configuration Schema**: `values.yaml` exposed four settings the backend never reads — `HOST`, `LOG_LEVEL`, `AZURE_ENTRAID_CLIENT_SECRET` and the `NOSQL_DB_*` aliases — and was missing three it does: `MARKETING_OPT_IN_ENABLED`, `MARKETING_OPT_IN_VERSION` and `NPM_REGISTRY_URL`, so the registration consent could not be turned on through the chart at all. The install notes no longer accept `NOSQL_DB_URL` in place of `NOSQL_DATABASE_URL`, which would have suppressed the warning while the application failed to reach the database

### Fixed

- **Startup No Longer Depends On How Long The Migration Takes**: The database plugin waits for the migrations before declaring itself ready, and Fastify gives a plugin 10 seconds: the organizations migration ran one query per project and one per member, so it overran on a remote database. Past the limit `build()` throws, the process never reaches `listen`, and nginx keeps serving the static files while the API answers 502. The migration now reads everything in a fixed number of round trips and writes with `insertMany` and `bulkWrite`, so it no longer depends on the size of the dataset. The inserts are unordered: a row that appeared in the meantime does not take the rest of the batch down. An explicit `pluginTimeout` of 60s was added as a safety net, since startup measures 12s even without a database. The database plugin now calls `done()` when no URL is configured as well — before it hung, so an installation without a database would not even answer to say so

- **The Project No Longer Follows You Across Organizations**: Invalidating `"projects-mine"` matches by prefix, so it also put the leaving organization's query back in flight. Its response arrived after the switch had happened and, that tenant having a single project, made it active and wrote it back to localStorage: the header ended up showing a project under an organization it does not belong to. The response is now discarded if the organization is no longer the selected one. Project selection follows a single order — the one in use, the remembered one, the only candidate — instead of two branches overwriting each other, and when nothing valid is left the remembered project is forgotten. Covered by `e2e/tests/organizations/multi-organization-login.spec.ts`

- **The App Button Forwards Its Ref**: The wrapper was a `React.FC` around the design system's `Button`, which is `forwardRef`, so the ref stopped there. Radix `asChild` triggers use it to anchor the panel and manage focus, so the Dialogs and DropdownMenus built on this Button started without an anchor and React flagged the component as not referenceable

- **Missing `await` In `MicrofrontendService`**

- **Switching Tab On The Microfrontend Page Did Nothing**: The panels are mounted with `forceMount` so the form keeps its values across tabs, but Radix then stops applying `hidden` — all four panels rendered stacked in a column and clicking a tab only moved the highlight. `TabsContent` in the design system now hides inactive panels by `display`, so the fields stay registered. Released as `@mfe-orchestrator/design-system@1.4.2`

### Documentation

- **User-Facing Pages Moved To The Documentation Site**: Canary releases, host integration and build status were documented both under `docs/` and on mfe-orchestrator.dev/documentation, and the repository import and dependency analysis pages have now been ported there too, so the copies in this repository only duplicated the doc site and drifted from it. The five pages and the nine screenshots only they used are gone, and README, CHANGELOG and the three agent instruction files point at the published pages instead. `docs/TELEMETRY.md` and `docs/SECRETS.md` stay: the first is the URL `telemetry.ts` logs at startup and returns from `GET /api/telemetry/status`, the second is named by the warning `config.ts` prints when `SECRETS_ENCRYPTION_KEY` is unset, and neither has an equivalent page on the doc site
- **Screenshot Capture Script**: `e2e/tests/screenshots.spec.ts` drives the builds, integration and deployment history pages with a fixed viewport and captures the raw images the documentation pages are built from, dumping the page text along the way. It is a capture script rather than a test: it signs in with a specific docs account, so it only runs where that account exists. The deployment history step walks the environments looking for one deployed more than once and, finding none, redeploys the one that already has a snapshot; its viewport is taller than the other captures on purpose, because the app scrolls inside its own container, so `fullPage` stops at the viewport
- [Build status](https://mfe-orchestrator.dev/documentation/docs/deployments/build-status) — what the builds page shows, how the run status is read from GitHub Actions, GitLab pipelines and Azure DevOps, the 15-second poll behind the live stream, and `GET /api/builds` with `GET /api/builds/stream`
- [Canary releases](https://mfe-orchestrator.dev/documentation/docs/microfrontends/canary-releases) — the three canary strategies, how the decision is pinned into the served URL, enrolled users and their carry-over across a new deployment, and the boot migration of the legacy values
- [Host integration](https://mfe-orchestrator.dev/documentation/docs/integration/overview) — wiring a host application to the orchestrator: the serve endpoints, the generated configuration per stack, the bootstrap and the global variables script
- **README**: the environment variable table was reconciled with the configuration schema — four defaults were wrong (`REGISTRATION_ALLOWED`, `MICROFRONTEND_HOST_FOLDER`, `NODE_ENV`, `JWT_SECRET`), `LOG_LEVEL` and `AZURE_ENTRAID_CLIENT_SECRET` are read by nothing and were removed, and thirteen variables that the backend does read were missing, the marketing opt-in flags among them. The development URLs, the required Node version and the `pnpm` script list were corrected as well
- **Existing pages**: `TELEMETRY.md` states the failure logging and the `NODE_ENV` precedence accurately, `DEPENDENCIES.md` names the endpoints that actually take a `branches` map and carries the `/api` prefix, and `REPOSITORY-IMPORT.md` no longer claims that already-imported repositories show their slug or that a selection survives a partial failure
- **Agent instruction files**: `.cursorrules`, `.github/copilot-instructions.md` and `.windsurf/rules.md` no longer point at shadcn/ui in place of `@mfe-orchestrator/design-system`, no longer list four `pnpm` scripts that do not exist, and name the current local ports

---

## [3.1.0] - 2026-08-16

### Fixed

- **Enrolled Users Survive A New Deployment**: Enrolment is stored per deployment, so a fresh deployment started with nobody on the canary and every enrolled user silently dropped back to the stable version. The rows of the deployment being replaced are now copied into the new one, inside the transaction that creates it, scoped rows included
- **Concurrent Canary User Writes**: The batch canary user writes ran through `Promise.all`. A transaction runs every operation on a single session, and MongoDB refuses two commands carrying the same transaction number at once — which is exactly what firing them concurrently did as soon as more than one id was passed. `setCanaryUserMultipleRaw` and `createMultipleRaw` now await in sequence

### Changed

- **Microfrontend Card**: The canary type and deployment type badges were dropped from the card, leaving the percentage bar and the canary version
- **Image Builds**: The pnpm update notifier is silenced in both Docker images, so it no longer writes into the build output

### Tests

- **Profile Page**: The profile page is covered end to end — the personal data form, and avatar upload, replacement and removal with the size and type rules — with the avatar rules also covered on `UserService`. The profile components carry the test ids the suite selects on

---

## [3.0.0] - 2026-08-16

### Added

- **Build Screen**: A dedicated builds page lists the pipeline runs of every microfrontend of the project and streams their status live over server-sent events, with the run history and a status badge per microfrontend. The status is read through the provider each microfrontend is hosted on — GitHub Actions, GitLab pipelines and Azure DevOps builds — and exposed by `GET /api/builds`
- **User Profile Page**: A profile page where the logged in user edits their personal data and uploads, replaces or removes their avatar. The avatar is stored server-side and is what the sidebar user button renders
- **Canary Strategies**: The canary is no longer a single on/off split. A microfrontend picks between a random percentage, a sticky per-session assignment, and an explicit list of enrolled users, and the release settings moved into their own section of the microfrontend form. Existing microfrontends are migrated on boot
- **Bulk Canary User Actions**: Canary users can be enabled, disabled or removed in bulk from the selection in the canary users table
- **Global Variables Script**: The generated integration writes a global variables script straight into the host document, addressed per project, so a host picks up the environment variables of the project without wiring them by hand. The integration dialog generates and previews it
- **Marketing Opt-In At Registration**: The registration form collects a marketing consent, stored on the user and gated by configuration, so it only shows where the deployment enables it
- **Last Login Tracking**: The user record keeps the date of the last login, updated when a token is issued
- **Per-Page Document Head**: Every page sets its own document title through a `PageHead` component, the authentication and single-page layouts included
- **Logged In User In The Bootstrap**: The generated bootstrap names the logged in user, so a host can read it without an extra call
- **Sidebar Logo**: The sidebar header shows the MFE Orchestrator logo

### Changed

- **Generated Configuration Carries Its Origin**: `backendUrl` and `projectId` are written into the generated configuration, so a served microfrontend knows which backend and project it belongs to without being told
- **Microfrontends Table**: The host is rendered as an icon instead of a text column and the canary cell has room for the strategy it now describes
- **Microfrontend Graph Nodes**: The nodes of the microfrontend flow were redrawn into their own component
- **Error Handling**: The unregistered error handler was dropped and the not-found errors became typed per entity (`EnvironmentNotFoundError`, `ProjectNotFoundError`), so the plugin answers with the right status
- **Lint**: Unused-import removal is enforced across the whole repo, hooks included

### Fixed

- **Serving On The Resolved Environment**: Microfrontend files are served on the environment actually resolved from the request instead of a stale one
- **Federated Access Decision**: A federated access is decided from the token instead of from a request header
- **Scoped Package Registry URL**: The whole npm package name is encoded in the registry URL, so scoped packages resolve
- **Mail Fixture Decoding**: The ampersand entity is decoded last in the end-to-end mail fixture

### CI

- The monorepo build no longer runs on pull requests
- The actions pinned by the workflows were upgraded

---

## [2.3.0] - 2026-08-11

### Added

- **Bulk Repository Import**: From the microfrontends dashboard, an "Import from repository" action lists every repository reachable through a code repository connection (GitHub account/organization, GitLab group, Azure DevOps project) and creates a microfrontend for each selected one. Repositories already linked to a microfrontend are flagged and skipped, slug collisions get a numeric suffix, and each import is reported individually so one failing repository does not abort the batch. Backed by `GET /api/repositories/:codeRepositoryId/importable-repositories` and `POST /api/repositories/:codeRepositoryId/import`, documented in [Import repositories as microfrontends](https://mfe-orchestrator.dev/documentation/docs/repositories/import-microfrontends)
- **Module Federation Integration**: One button wires module federation into every microfrontend of a project, and the console generates the integration instructions for the stack each microfrontend actually uses instead of a single generic snippet
- **Stack Detection**: Every microfrontend remembers the stack it was detected on, which is what lets the generated configuration match its build tool
- **Cross-Repository Dependency Analysis**: Scans the repositories of a project through the provider API, compares the declared ranges against the npm registry and rewrites the misaligned `peerDependencies` on a dedicated branch. Each microfrontend can be compared on a branch of its own. Documented in [Dependency analysis](https://mfe-orchestrator.dev/documentation/docs/repositories/dependency-analysis)
- **Server-Side Canary Resolution**: The canary version is resolved on the backend and pinned in the URL, the per-user enrolment is reachable, and the deployment cards show the split each microfrontend is serving
- **Environment-Free Serving**: The manifest, the global variables and the microfrontend configuration are served without an environment in the URL, so one build reaches every environment
- **Dedicated Serve CORS Allow-List**: `ALLOWED_SERVE_ORIGINS` applies its own list to the `/serve/*` endpoints, falling back to `ALLOWED_ORIGINS`
- **Configurable Rate Limit**: The per-IP request ceiling is configurable instead of hardcoded
- **Design System Adoption**: The frontend renders through `@mfe-orchestrator/design-system`, sidebar included, in place of the local UI components
- **Secret Visibility Toggle**: Secret values can be revealed and hidden again in the forms that hold them
- **Clone With IntelliJ**: The clone popover of a microfrontend offers the JetBrains protocol next to HTTPS and SSH
- **End-To-End Coverage**: Playwright suites for login, project creation, project invitations, and CRUD of environments, API keys and storage providers

### Changed

- **Repository Listing Pagination**: `GithubClient.getRepositories` and `GitlabClient.getRepositoriesByGroupId` now walk every page instead of returning only the provider's first page (30 repositories on GitHub, 20 on GitLab), so repository pickers and the bulk import see the complete list
- **Host Injection Dropped**: The old host injection is replaced by the federation integration
- **Client SDK Scope**: The generated configurations and the published package both point at the `mfe-orchestrator-hub` scope
- **Pinned Deployable Infrastructure**: The Compose file, the Terraform module and the Helm chart name the released tag instead of `latest`

### Fixed

- **Invalid Object Ids**: An invalid id is rejected instead of being turned into a fabricated one
- **Request Bodies**: Only JSON bodies are accepted, with multipart scoped to the upload route
- **Generated Bootstrap Snippet**: The environment is optional, and the webpack profiles match the reference templates
- **Members Page Request Loop**: The project members page stops re-requesting in a loop
- **Repository Fetch Loop And 429s**: The repository fetch no longer loops into the rate limiter
- **View Switcher Alignment**: The microfrontends view switcher lines up with the header buttons

### Documentation

- [Import repositories as microfrontends](https://mfe-orchestrator.dev/documentation/docs/repositories/import-microfrontends) — importing repositories as microfrontends, with the API reference
- [Dependency analysis](https://mfe-orchestrator.dev/documentation/docs/repositories/dependency-analysis) — how the dependency scan and the peer dependency alignment work

---

## [2.2.0] - 2026-08-07

### Added

- **Reworked GitHub Connection**: The GitHub code repository connection was updated end to end

### Fixed

- **Self Invitations**: A user can no longer invite themselves to a project
- **Team Mates And i18n**: Missing translations and the team mates screen of the project
- **Login**: A login failure on the embedded provider

---

## [2.1.0] - 2026-08-06

### Added

- **All-in-One Docker Image**: `Dockerfile.all-in-one` builds a single container with the orchestrator, MongoDB (single node replica set, so transactions work), Redis and Nginx. `docker run -p 8080:80 -v mfe-data:/data lory1990/mfe-orchestrator:all-in-one` is a complete installation: no sidecar containers, all the state under `/data`, databases bound to the loopback and a JWT secret generated on first start. Supervisor keeps the four processes alive and takes the container down when one of them cannot start
- **Anonymous Telemetry**: Self-hosted installations send one anonymous ping per day with aggregate counters only (`installationId`, `version`, `nodeVersion`, `projects`, `microfrontends`, `environments`, `users`, `deploymentsLastWeek`). Enabled by default, off with `TELEMETRY_DISABLED=true` or `DO_NOT_TRACK=1`, never sent when `NODE_ENV` is not `prod`. The full payload is disclosed in the startup log, inspectable via `GET /api/telemetry/status` and documented field by field in [docs/TELEMETRY.md](docs/TELEMETRY.md)
- **Helm Chart**: `helm/mfe-orchestrator` installs the orchestrator on Kubernetes, with every environment variable exposed through `values.yaml`, ingress, persistence, probes, autoscaling and secrets kept outside the values file
- **Design System Package**: `@mfe-orchestrator/design-system` is consumed from GitHub Packages
- **New Project Wizard**: Restored and reused on the first run, sharing the storage form and the environment setup with the rest of the console
- **Redesigned Dashboard And Project Picker**: The microfrontends dashboard was redesigned, and the post-login picker shows projects as large tiles while making it clear that the switcher also creates them
- **Drag And Drop Environments**: Environments are reordered by dragging them
- **Clone Urls**: Microfrontends carry their HTTPS and SSH clone urls, offered through a clone popover
- **Apache-2.0 License**: The project is licensed under Apache-2.0

### Changed

- **Transactional Emails**: Aligned with the design system
- **Node 24**: Both the build and the GitHub Actions runners moved to Node 24

### Fixed

- **Telemetry**: The ping always carries a valid installation id and reaches the dedicated telemetry service
- **Translation Cache**: The browser cache of the translation files is busted on release, and the environments screens no longer miss strings
- **Project Users Cache**: Refreshed after sending an invite
- **Docker pnpm Version**: Pinned to the version declared in the workspace `packageManager`

### Documentation

- README rewritten as a landing page

---

## [2.0.0] - 2026-08-04

No changelog was kept for this release. See the
[release notes](https://github.com/mfe-orchestrator/mfe-orchestrator/releases/tag/2.0.0)
and the commits between `1.2.0` and `2.0.0`.

---

## [1.2.0] - 2026-07-14

No changelog was kept for this release. See the commits between `1.0.0` and `1.2.0`.

---

## [1.0.0] - 2025-12-07

### Added

- Microfrontend orchestration hub with JSON-based configuration
- Multi-environment support (DEV, UAT, PROD, etc.)
- Project management with user roles and permissions
- Environment-specific microfrontend configurations
- Deployment management system
- Code repository integration (GitHub, GitLab, Azure DevOps)
- Storage integration (S3, Azure Storage, Google Cloud Storage)
- API key authentication
- User authentication (Local, Auth0, Azure AD, Google OAuth)
- Global environment variables management
- Canary deployment support
- Market/templates library
- Comprehensive error handling
- API documentation with Swagger
- **Monorepo Architecture**: Migrated to pnpm workspace with centralized dependency management
- **Turbo Build System**: Added Turborepo for optimized build and task orchestration
- **Biome Integration**: Replaced ESLint + Prettier with Biome for unified linting and formatting
- **Lefthook Git Hooks**: Migrated from Husky to Lefthook for improved git hook management
- **Commitlint Integration**: Added automated conventional commit validation
- **VSCode Configuration**: Added shared VSCode settings and extensions for team consistency
- **Centralized Configuration**: Unified Biome configuration for consistent code style across packages

### Changed

- **Package Management**: Migrated from individual package management to centralized pnpm workspace
- **Build System**: Replaced individual build scripts with Turbo-powered monorepo builds
- **Code Quality**: Unified linting and formatting across backend and frontend with Biome
- **Git Hooks**: Improved pre-commit hooks with optimized file processing and parallel execution
- **Development Workflow**: Streamlined development setup with workspace-level commands

### Fixed

- **Version Mismatches**: Resolved Fastify and Mongoose interface compatibility issues
- **Dependency Conflicts**: Eliminated duplicate dependencies across packages
- **Code Style Inconsistencies**: Standardized formatting and linting rules project-wide
- **Git Hook Performance**: Optimized hook execution with glob patterns and parallel processing

### Removed

- **Husky**: Replaced with Lefthook for better performance and configuration
- **ESLint + Prettier**: Replaced with Biome for unified tooling
- **Individual pnpm-lock files**: Consolidated to workspace-level dependency management
- **Duplicate configurations**: Removed redundant config files across packages

### Documentation

- README with environment variables
- Cursor rules for development workflow
- Commit conventions documentation
- Security documentation

---

## Versioning

We use [SemVer](http://semver.org/) for versioning. Given a version number MAJOR.MINOR.PATCH, we increment the:

- **MAJOR** version when we make incompatible API changes
- **MINOR** version when we add functionality in a backwards-compatible manner
- **PATCH** version when we make backwards-compatible bug fixes

### Commit Type to Version Mapping

- **`feat`** commits → **MINOR** version bump
- **`fix`** commits → **PATCH** version bump
- **BREAKING CHANGE** → **MAJOR** version bump

## Legend

- **Added** - New features
- **Changed** - Changes in existing functionality
- **Deprecated** - Soon-to-be removed features
- **Removed** - Removed features
- **Fixed** - Bug fixes
- **Security** - Security improvements

## How to Update This Changelog

This changelog is maintained manually but can be generated automatically using tools that parse Conventional Commits. When making changes:

1. Add your changes under the appropriate section
2. Follow the format: **"- Brief description of change (#PR number)"**
3. Group changes by type (Added, Changed, Fixed, etc.)
4. Place the most recent changes at the top of each section
5. Link to related issues or pull requests when applicable

### Example

```markdown
## [1.1.0] - 2024-01-15

### Added

- Dark mode support for the UI (#123)
- Export project configuration as JSON (#124)

### Changed

- Improved deployment performance (#125)

### Fixed

- Resolved authentication token expiration issue (#126)
```

## Automated Changelog Generation

This project can use tools like:

- [standard-version](https://github.com/conventional-changelog/standard-version)
- [semantic-release](https://github.com/semantic-release/semantic-release)
- [release-please](https://github.com/googleapis/release-please)

These tools automatically:

1. Parse Conventional Commits
2. Generate changelog entries
3. Bump version numbers
4. Create git tags
5. Generate release notes

## Release Workflow

1. Merge feature branches into main
2. Generate changelog from commits
3. Bump version according to Conventional Commits
4. Tag release
5. Publish release notes

---

**Note**: This is a living document. As we release new versions, this changelog will be updated to reflect all changes.
