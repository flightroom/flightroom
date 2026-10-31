# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Shell Commands For Edit With AI**: with an OpenShell gateway the agent gets `run_command` beside `run_script`, which runs any shell command in the sandbox, at the root of a repository or in a folder of it, for up to 10 minutes: the build and tests of a repository without a `package.json` (Maven, Gradle, Go, .NET, Python), one test file, a tool the scripts do not run. What it changes in the repository joins the change as for a script, counted in the 500 KB the agent may write, and the output of both, as the agent reads it, has the usual credential shapes masked. It does not get the `.npmrc` of the design system, which stays with `run_script`
- **Sandbox Time In The AI Usage**: the AI usage cards count, by Edit with AI, missions and live previews, the scripts and commands run in a sandbox and how long they ran, and how long each sandbox lived, idle minutes included until it is deleted. Shown in minutes once there is some, beside the tokens; the API returns it as `sandbox` on each summary and on each project of the organization's
- **Missions Apart In The AI Usage**: the tokens of the jobs of a mission are counted as `mission`, apart from those of Edit with AI, from now on

### Changed

- **A Build Before Finish For Every Stack**: a repository changed by the agent with no `build` script in `package.json` must now have run, before `finish`, the check command of the files at its root: `mvn -B -q verify` (or `./mvnw`), `./gradlew build --no-daemon -q`, `go build ./... && go vet ./...` or `dotnet build`, when the sandbox image has its toolchain: the default image has Node.js only. Run is enough, not passed, as for the build script. Code a script or a command other than the build changes afterwards has to be built again

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
