# Editing a frontend or a backend with AI

From **Edit with AI**, the screen a frontend or a backend opens on, a user describes a change ("add a 404 page"). An
AI agent works on a local clone of its repository and proposes the change as a diff.
Under the prompt, the console shows the repository it works on, linked to its page on the provider, and the
branch it starts from: the repository's default branch unless another one is picked from its branches.
Once the agent is done, the console commits the proposal on a feature branch of its own and pushes it:
the base branch is never touched until the user acts. Then the user can:

- **Apply** it: the proposal is pushed straight onto the base branch, with no review.
- **Open a pull request** (a merge request on GitLab) from the feature branch onto the base, to have it
  reviewed in the repository first. The proposal stays open: it can still be refined, applied or discarded.
- **Discard** it: its feature branch is deleted, unless a pull request is open on it.

Each request is a conversation. Once the proposal is ready the user can keep chatting with the agent to
refine it ("also translate the page"). Each message is a follow-up: the agent starts from the files of
the previous proposal, is told what was asked before, and its new proposal replaces the previous one.
Only the latest proposal can be applied. Every follow-up force-pushes the same feature branch, so a pull
request opened on it shows the latest proposal. A failed follow-up leaves the previous proposal open to apply
or to refine again. Once a proposal is applied or discarded, the conversation is closed and a new change
starts from the base branch. The commit and the pull request are named after the first message, and the pull
request description quotes every message of the conversation. Once a proposal is applied, the whole conversation is kept, not removed
with the proposals.

A request and its follow-ups can carry up to five images (PNG, JPEG, WebP or GIF), pasted, dropped or
attached. The console scales them down to 1568 px on the long edge and refuses one still over 2 MB. They are
saved on the job, never in its transcript, and expire with it. The assistant and MCP stay text only.

It is available when an [AI provider](AI-PROVIDERS.md) is configured and the frontend or backend has a
code repository connected (GitHub, GitLab or Azure DevOps).

## How it works

**View live preview** in a frontend or domain workspace starts the default branch in an isolated
OpenShell sandbox, without creating an AI job. On a domain it starts the connected frontend and
backend repositories together; the preview URL is the sandbox's frontend, not a deployed environment.
The sandbox is removed after the configured OpenShell idle period.

1. The request is stored and a background job starts; the console follows it by polling.
2. The job clones the repository into a working copy of its own, on `origin/<base branch>`: every run
   starts from exactly what the remote has, and jobs on the same repository run side by side, each
   with its own checkout. Their proposals only meet when they are applied (step 6).
3. The agent explores and edits the files. It receives the [project and frontend context](MCP.md#project-context)
   and the detected stack.
4. The changed files are committed on the conversation's feature branch,
   `ai-feature/<a few words summing up the request, written by the model>-<timestamp>` (author: the user who asked, committer: Flightroom), on top of
   the base the agent started from, and force-pushed. A follow-up that only answers a question, without
   changing a file, pushes nothing. A push that fails does not lose the proposal: the console shows the
   error, and applying it or opening its pull request pushes it again.
5. The changed files (original and proposed content) are stored as a proposal and the job's working
   copy is deleted; one a crash left behind is removed a day later. Proposals nobody acts upon are removed after 7 days; their branch stays.
6. On **Apply** the shared working copy of the repository, locked meanwhile (Redis, or in-process
   without Redis), is reset to the latest base and every file is checked to still be what the agent
   saw. A file changed on the base branch in the meantime, by another job applied first for instance,
   stops the apply with a conflict, so nothing is silently overwritten. When the base has not moved
   since the proposal, the base fast-forwards to the very commit of the feature branch, so a pull request opened on it reads merged;
   otherwise the files are committed again on top of the latest base. The push is never forced: a
   protected base branch refuses it, and the console suggests opening a pull request instead. The
   feature branch is then deleted, unless a pull request is open on it.
7. On **Open a pull request** the provider opens it from the feature branch onto the base. If it refuses
   (for example a token without that permission), the console shows why and the branch stays pushed.

Clone, fetch, commit and push use [isomorphic-git](https://isomorphic-git.org): no `git` binary is
needed in the image, and no repository hook is ever run.

## Changing a whole domain

**Edit with AI** on a functional domain starts one agent on every frontend and backend of the
domain that has a code repository (at most 10), with the project and domain context. It sees them all
at once, so one change can span an API and the screens that call it, and it still proposes one diff
per repository, each on its own feature branch, applied or opened as a pull request on its own. Each
repository starts from the branch picked for it, its default branch otherwise; one choice sets them all at
once, either back to their own default branches or to a branch every one of them has. Each message of the conversation shows
one tab per repository, with its own files and diff, opened on the first proposal to review. Members without
a repository are left out and listed under the request. These conversations stay in the domain's queue and do
not appear in the individual frontend or backend queues.

When the domain has nothing for the agent to work on yet, **Generate** first offers to create it:

- **No frontend and no backend:** one model call proposes the components the request needs
  (usually a frontend and a backend, at most 3 of each), each with a name, a slug, a template and a
  repository name ending in `-fe` or `-be`. The user reviews and edits the proposal; on confirmation
  the console creates each one in the domain with a new repository scaffolded from its template, then
  starts the job on them.
- **Members, none with a repository:** the console asks to create one per member (named
  `<slug>-fe` or `<slug>-be`, scaffolded from the member's template or the default of its kind), then
  starts the job.

Both need a code repository connection on the project. Creating a repository for an existing member
is also available as `POST /frontends/:id/repository` and `POST /backends/:id/repository`;
viewers cannot use it.

## Fleet: missions on many repositories

The **Fleet** page sends one request ("upgrade React to 19") to many repositories at once: every
frontend and backend of the project with a code repository, or the ones picked from the list. This is
a **mission**. A mission runs no agent of its own. It starts ordinary jobs, and each job proposes one
diff per repository, reviewed, applied or opened as a pull request like any other.

A mission runs in one of two modes:

- **Global**: one agent sees several repositories together, so a change can span an API and the screens
  that call it, as on a domain.
- **Per repository**: each repository gets its own agent with the same prompt. The agents do not see each
  other's work, so one failure stays in its own repository.

The repositories are split into **batches of 10**, in the order they are listed, and the batches run one
after the other: batch 2 starts only once every job of batch 1 has finished or failed. In global mode a
batch is one job on its 10 repositories, so with more than 10 the agent only sees the repositories of its own
batch. In per-repository mode a batch is up to 10 jobs on one repository each. At most `concurrency` of
them run at once (1 to 10, 3 by default), and as one finishes the next repository of the batch starts. A
repository whose job cannot start (its repository was disconnected in the meantime, say) is marked failed
and the mission goes on without it. The mission is done once the last batch is over, and failed if every
one of its jobs failed.

**Stop** stops the jobs at work, which are dropped like a stopped job, and the repositories still queued
never start. **Apply all** applies the proposals of every finished job, one job after the other, as each
job's own **Apply** would. A proposal can also be applied on its own from the job, before the mission ends.
A follow-up asked on one of its jobs (from the Fleet page or the assistant) stays part of the mission: the
mission shows the follow-up's proposal in place of the one it refines, and **Apply all** applies that one.
A follow-up takes no place of its own among the active jobs, and never holds up the next batch.

Limits:

- At most 200 repositories per mission.
- A running mission takes one of the 5 places for AI work at once in a project, however many jobs it
  runs. Its jobs do not take places of their own.
- While a mission runs, its jobs and their proposals do not expire, however long ago they finished. Once it
  ends, the mission, its jobs and the proposals nobody applied are removed 7 days later. Applied work is
  kept, and branches stay.
- A mission waiting for a job that died with the server (a restart, say) moves on by itself: the server
  checks the running missions when it starts and every few minutes, and a job silent for 20 minutes counts
  as failed.

Who can use it: any member of the project sees everyone's missions. A member assigned to some domains
only sees the missions whose repositories are all in those domains. Such a member can start a mission on
repositories they pick from their domains, but never on every repository of the project. Viewers can
neither start, stop nor apply a mission; organization administrators can. Only the user who started a
mission, or an organization administrator, can stop or apply it: everyone else sees it read only. Starting and applying a mission
count against `ASSISTANT_RATE_LIMIT_MAX`, per user. Every job runs as the user who started the mission,
whoever's visit to the Fleet page moves it on, so its commits are authored by that user.

## Where the repositories are cloned

```
$REPOSITORIES_FOLDER/<organization-slug>-<id>/<project-slug>-<id>/<frontend-slug>/
$REPOSITORIES_FOLDER/<organization-slug>-<id>/<project-slug>-<id>/<backend-slug>.service/
```

| Variable                        | Default                                              | What it does                                         |
| ------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| `REPOSITORIES_FOLDER`           | `/repositories`, `/data/repositories` in all-in-one | Root of the clones.                                  |
| `REPOSITORIES_MAX_SIZE_MB`      | `500`                                                | A clone bigger than this is refused and deleted.     |
| `REPOSITORIES_EVICT_AFTER_DAYS` | `14`                                                 | Clones not used for this long are deleted.           |

The folder is a **cache**: deleting it only costs a new clone. Clones are also removed when their
frontend or project is deleted. On Kubernetes the chart mounts an `emptyDir` there
(`repositories.sizeLimit`, 10Gi by default); set `repositories.existingClaim` to keep the clones across
restarts. Each replica can have its own folder: there is no state to share.

Credentials are never written to disk: the clone URL has no token in it and the provider token is
handed to each network call.

## What the agent can and cannot do

- It can list, search, read, write and delete files **inside the working copy only**. Every path is
  resolved after following symlinks: `..`, absolute paths, `.git` and symlinks pointing out of the
  repository are refused.
- It cannot read files that usually hold credentials (`.env*`, `.npmrc`, `*.pem`, `*.key`, ...).
- It cannot change CI configuration (`.github/workflows`, `.gitlab-ci.yml`, `azure-pipelines*.yml`) or
  write lockfiles: a pushed branch runs CI with the repository secrets. A lockfile changes only through
  the install run in a sandbox (below), and its diff is reviewed like the rest. Since every proposal is pushed on its
  feature branch as soon as the agent is done, a pipeline that runs on every branch runs on the
  agent's code before anyone has reviewed it: limit such pipelines, or their secrets, to protected branches.
- Without a sandbox it cannot run anything: no install, build or test. The repository's CI checks the
  pull request. With an [OpenShell gateway](#running-install-lint-test-and-build) it runs the install, the
  scripts of `package.json` and its own shell commands in an isolated sandbox, never on the console.
- It is told the config maps, secrets and resources attached to each backend by the names of their
  variables, never a credential (see [SECRETS](SECRETS.md#in-the-api)). When a backend attaches an `api`
  resource it gets `read_api_spec`, which reads the OpenAPI document pasted in the console, or fetches its
  `specUrl` from the backend with no access to private addresses, and answers with an index of the
  operations or one operation in full.
- It reads the console, never changes it: see [Reading the console](#reading-the-console).
- At most 20 files and 500 KB written per repository (2 MB per job), 40 model rounds plus 20 per extra
  repository (120 at most).
- It never pushes. The console pushes its proposal on a feature branch only, never on the base branch:
  only the user's **Apply** writes there.

## Reading the console

The agent of Edit with AI and of missions gets the read tools of the [MCP server](MCP.md#what-the-client-can-do),
run in process as the user the job runs for, bound to the project of the job: whoever started it, or, for a
follow-up, whoever asked for the follow-up. It never passes a project, and every id it passes is checked by the
console against that project, and against the domains of a domain-scoped member, as for that user in the console.
Each call is written to the log as an audit line (`ai_job_console_tool_call`: tool, ids, job, user). With them it
diagnoses before changing code:

- the CI runs of each frontend and backend and the logs of a failed one (`build_status_get`, `build_run_logs_get`);
- the pods of a backend or a container frontend in an environment, with each container's CPU and memory requests
  and limits, restarts, current state (`CrashLoopBackOff`, `ImagePullBackOff`...) and how its previous run ended
  (`OOMKilled`, exit code), and what they log (`application_pods_list`, `application_logs_get`);
- the environment variables a container gets (`container_environment_get`), built by the same function the deploy
  writes the Helm values with: `HTTP_PORT`, `LOG_LEVEL`, `LOG_JSON`, `ENVIRONMENT`, `PUBLIC_URL`, the OpenTelemetry
  variables, then the URLs of the backends and DOCKER frontends of the environment (`services.flightroom`, first of the `envFrom`), the
  config maps, secrets and resources in the order of the chart's `envFrom`, each with its source and,
  when another source sets the same name and wins (`env` over `envFrom`, a later `envFrom` over an earlier one),
  `overriddenBy`. Values of secrets and resources are masked (set, and their length). Global variables are not
  there: they reach the browsers, not the containers. `state` says what the list is: `next_deploy`, what the next
  deploy hands the container; `not_in_deploy`, the environment sets no version of it and a container may still run
  with what an earlier deploy wrote; `no_gitops`, the project deploys no container through GitOps;
- the rest of the read-only catalog: the project, its environments, domains, frontends, backends and their
  versions, deployments, config maps, the names and keys of secrets, global variables, resources (credentials masked).

Every write of the catalog is left out, and so are the read tools that hold or reach credentials, masked or not:
`secret_get`, storages, databases, the repository connections and `repository_checkout_get`, the console-only ones
(members, API keys, MCP clients, AI jobs), and those that help no change to the code, whose definitions the model
would read on every round: `user_ai_usage`, canary users, templates, resource types, domain links, dependency and
integration plans, the promotion preview. A fix that needs the console changed (a variable,
a memory limit, replicas, a deploy) is written in the summary for the team to make.

Every result of these tools, whichever the tool, comes to the model inside `<console_data untrusted="true">`, which
no text of it can open or close: CI and pod logs, commit and termination messages, variable values and what the
team configured may all have been written by someone other than the user. The usual credential shapes are masked
(connection strings of any scheme included), each text keeps only its end (8,000 characters) and a long list its
latest items: the prompt tells the agent it is evidence, never instructions. Each result is cut at 20,000
characters, and counts in the tokens of the job like the rest; when the history of a follow-up keeps only the start
of a result, the tag is closed again after the cut.

## Vega supervises the agent

The console assistant (Vega) delegates code changes to this agent and follows it, with tools only it has: they
live in `assistantOnlyTools`, never in the MCP catalog, so an MCP client can neither start nor drive the agent.
Each acts as the user of the conversation, through the same services as the console (role, domain scope, token
limit, the project's cap of 5 jobs), and only on the jobs and missions the conversation started.

| Tool | Kind | What it does |
|------|------|--------------|
| `agent_run_start` | write | Starts a job on a domain, on chosen frontends and backends, or with `all` on every one of the project with a repository (at most 10), with a base branch per repository, effort and AI, and a brief that carries the evidence Vega gathered (logs, env, pod state) so the agent does not investigate again. |
| `agent_run_status` | read | Status, latest steps, the commands it ran with their exit codes (the final check among them), per repository the files changed with lines added and removed (counted cheaply: what lies between the lines both versions share at their start and end), branch and pull request, tokens, cost and sandbox time. The exact diff of one file only with `path`, cut at 20,000 characters. |
| `agent_run_wait` | read | Waits up to 60 seconds for the job to end (the stream stays open on its heartbeats), then returns the status. |
| `agent_run_follow_up` | write | A follow-up on the job: it is linked to the conversation. A follow-up asked from the console is not. |
| `agent_run_stop` | write | Stops a job queued or at work. |
| `agent_run_apply` | confirm / destructive | `pull_request` opens a pull request from each feature branch (a confirmation), each outcome told on its own; `push` brings the proposals onto their base branches (destructive). The card lists, per repository still proposed, the branch, the base it goes to and its file count. |
| `agent_run_discard` | confirm | Discards every proposal of the job still open. |
| `mission_start` | confirm | Starts a [mission](#fleet-missions-on-many-repositories): the card says the branch it pushes to. |

The assistant has no other tool that starts, applies or discards an AI change or job: the console-only `ai_*` tools
it keeps only read them (`ai_changes_list`, `ai_change_get`, `ai_jobs_list`, `ai_job_get`, `ai_models_list`) or plan a
domain (`ai_domain_plan`). Confirmation cards are words the console writes in the user's language: the server sends
names, branches and counts only.

- **Link**: the job keeps `assistantConversationId`, and so does a mission. Every question carries the
  `conversationId` the panel saves the conversation under (the request is refused without it); a job of another
  conversation is not found (`AGENT_RUN_NOT_LINKED`).
- **Limits**: at most 3 agents of a conversation at work at once, a running mission counting as its jobs at work
  (one at least) (`AGENT_RUN_TOO_MANY`); at most 6 agents started (jobs, follow-ups and missions) and 3 follow-ups of
  one chain since the user last asked a question (`AGENT_RUN_TOO_MANY_STARTED`, `AGENT_RUN_TOO_MANY_FOLLOW_UPS`).
- **When a job or a mission ends**, the server adds a note to the conversation (`kind: "agent_update"`: ids,
  statuses and counts only, what the agents wrote being read with `agent_run_status`) and runs a turn of Vega on its
  own, saved like any answer (`origin: "server"`), so the outcome is reviewed with the chat closed. In such a turn,
  checked before anything runs or is parked, Vega reads, follows up and stops its own runs within the limits, and the
  tools waiting for a confirmation are parked for the user; starting an agent or a mission, and every other write of
  the catalog (builds, promotions, replicas, variables...), is refused with a message telling it to propose it in its
  answer. A question of the user left without an answer (failed, refused as busy) is marked unanswered in the history
  the turn reads, so it never runs what the user once asked. At
  most 5 update turns run between two questions of the user; past them only the notes are added. The turn runs as the
  conversation's user, with the AI of their last question (the project's default when it may not be used any more)
  and the effort of the last answer, `high` at most, within their token limit; it records its tokens as any answer
  (`assistant`) and confirms nothing: an action needing a confirmation waits on a card, for a day.
- **One turn at a time**: each turn, the user's or the server's, holds a lease on the conversation (`turnUntil`,
  3 minutes, renewed every minute while the turn runs and before each round of updates; a turn losing it stops). No
  turn runs longer than 10 minutes. A question asked while an update turn runs is refused with
  `ASSISTANT_CONVERSATION_BUSY`. An update finding a turn under way leaves it; it runs once the browser has saved that
  turn (the save of the conversation runs it, not the end of the stream): a turn of the user marks the conversation
  until the browser saves its answer, and no update runs on it before that, for 2 minutes at most. While an action of
  the conversation waits for the user, read from the store of pending actions (taken to wait when Redis is configured
  but down), only the note is added; a card is answered only from the conversation it was asked in. A job or mission is claimed once
  (`assistantNotifiedAt`), whichever replica sees it end; one Vega already read the end of in a turn
  (`agent_run_status`, `agent_run_wait`, `agent_run_stop`) gets no note. The end of a job is heard where it ends, the
  end of a mission where the mission ends or is stopped; the sweep of the server, every 5 minutes, fails linked jobs
  that died with their process and runs what was missed, 3 conversations at a time.
- **Saving**: the browser saves the whole conversation; the messages the server added and the browser has not seen
  are kept, each after the message it followed. Every write raises a `version` the save is guarded on; a save that
  keeps losing the race is refused (`ASSISTANT_CONVERSATION_CONFLICT`) rather than written over the server's messages.
- **In the chat**, each job of the conversation has a card (title, status, repositories, files changed, tokens, cost,
  sandbox time) opening its review tab, each mission one (status, repositories done, tokens) opening its page, and
  the conversation's cost is shown apart and summed: Vega's answers, the agents' tokens (from the AI usage ledger, by
  job, mission jobs included) and their sandbox time. The panel reads them from
  `GET /assistant/conversations/:id/agent-runs`, which reads no text of the conversation, polling every 5 seconds
  while an agent works or an update is to come and every 30 while only a mission works, and brings the server's new
  messages into the open chat; a card expired waits for nothing and holds nothing back.

## Running install, lint, test and build

The agent can check its own change when the console is given an [OpenShell](https://github.com/NVIDIA/OpenShell)
gateway. It then gets `run_script`, which runs `install` or one script of the repository's `package.json`
(`lint`, `test`, `build`...) with the repository's package manager (the `packageManager` field, else the
lockfile: pnpm and yarn through corepack, npm otherwise), and reads back the exit code and the end of the
output. It also gets `run_command`, which runs any shell command (`sh -c`) in the same sandbox, at the root of
the repository or in a folder of it (`workdir`, relative: no absolute path, no `..`), stopped after
`timeout_seconds` (10 minutes at most): the build and tests of a repository without a `package.json` (Maven,
Gradle, Go, .NET, Python), one test file, a tool the scripts do not run. Its output is read back like a
script's, with the usual credential shapes masked, and so are the files it changes, which unlike a script's
count towards the 500 KB the agent may write (lockfiles apart). Dependencies of `package.json` still go through
`run_script "install"`: a command does not get the `.npmrc` of the design system, only the package manager does.
A change is pushed once the agent is done, so it must have been built first: in every repository it changed,
`finish` is refused until it has run, after its last edit, the `build` script of `package.json`, or else the
check command of the files at the root of the repository: `mvn -B -q verify` (`pom.xml`; `./mvnw -B -q verify`
with `mvnw`), `./gradlew build --no-daemon -q` (`gradlew` with `build.gradle` or `build.gradle.kts`),
`go build ./... && go vet ./...` (`go.mod`), `dotnet build` (exactly one `.sln`, or no `.sln` and exactly one
`.csproj`). A check is asked for only when the sandbox has its program (`mvn`, `java` for a wrapper, `go`,
`dotnet`), looked up once per run: the default `node:24-bookworm-slim` image has none of them, so the checks of
non-Node repositories need an image or a template with their toolchain (`OPENSHELL_SANDBOX_IMAGE`,
`OPENSHELL_SANDBOX_TEMPLATE`). The Gradle wrapper also downloads Gradle from `services.gradle.org`, which is
not among the default `OPENSHELL_REGISTRY_HOSTS`: add it, or bake Gradle into the image. A repository with
neither a build script nor a check is not waited for. Run is enough, not passed: a build already broken on the
base branch must not hold the agent forever, and it says so in the summary. Code changed afterwards by a
script or a command that is not the build (`lint --fix`, a formatter, a generator) has to be built again; a
lockfile alone does not. An agent that ends with an answer instead of `finish` is asked once to build, then
its answer stands. A follow-up that changes nothing needs no build.
Scripts and commands run with `CI=true`, so test runners stay out of watch mode; the install does not, because
under CI pnpm and yarn freeze the lockfile and the install fails as soon as the agent changes a dependency
(pnpm gets `--config.confirmModulesPurge=false` instead, having no terminal to ask in).

The code runs in a sandbox, never in the console's pod: install scripts, build configurations and tests
are the repository's code, and the console holds the repository tokens, the database and the model keys.

- **One sandbox per conversation.** It is created at the first script of a request and named after the
  first job of the chain, so the follow-ups reuse it and find `node_modules` already installed.
- **Deleted when idle.** Once no job of the conversation has waited, run or ended for
  `OPENSHELL_SANDBOX_IDLE_MINUTES` (5), the sandbox is deleted. Every replica sweeps once a minute and
  tells what is idle from the database, so a sandbox outlives neither the replica that created it nor a
  restart.
- **Owned by the installation.** Each sandbox carries the label `flightroom.dev/owner`, the installation
  id kept in the database (or `OPENSHELL_SANDBOX_OWNER`), and its name hashes it together with the
  conversation. Installations sharing a gateway and a workspace see each other's sandboxes, and the sweep
  deletes only its own: a conversation it has no record of is another installation's, not an idle one.
  Two installations restored from one database share its id: give each its own `OPENSHELL_SANDBOX_OWNER`.
  Changing the owner leaves the sandboxes of the old one to nobody: delete them by their label. Every
  installation on the gateway has to run 8.4.0 or later, since an older one still deletes the others'.
  A script whose sandbox the gateway no longer has runs again once in a new one.
- **What goes in.** Each repository is copied whole at its first script of a request (everything but
  `node_modules` is replaced), then only the files the agent wrote or deleted. Files that may hold
  credentials (`.env*`, `.npmrc`, keys) are never copied.
- **What comes back.** Whatever a script creates or changes in the copy (the lockfile the install
  rewrites, the files `lint --fix` or a formatter corrects, generated code) is written into the working
  copy and becomes part of the proposal, whatever the exit code. Before each script the sandbox stamps a
  marker; after it, the files newer than the marker outside `node_modules` are hashed there, and those
  that differ from the working copy are read back gzipped, in pieces. Left out: what `.gitignore`
  excludes (builds, caches) and credentials, which stay in the sandbox; CI and registry configuration
  and binaries, which are sent again before the next script so the copy matches the working copy. A
  script that changes more than 200 files, more than 10 MB, or more files than the proposal may hold
  (20 per repository) brings nothing back, and the agent is told why. Deleted files are not seen. What
  comes back does not count towards the 500 KB the agent may write; in a follow-up the parent's files
  do, whole, as for anything the agent wrote, except lockfiles.
- **What goes out.** By default the sandbox may reach the package registries of `OPENSHELL_REGISTRY_HOSTS`
  (npm, Maven, PyPI, Go, NuGet, Azure Artifacts, GitHub Packages) on 443, only through the runtimes of
  `OPENSHELL_NETWORK_BINARY`, and nothing else. A private registry (Azure Artifacts, GitHub Packages...) is
  reached through the `.npmrc` of the frontend's [design system](MCP.md#design-system), credentials
  included: it is written into the sandbox, outside the copy of the repository, and the install and the
  scripts read it as their user configuration (`npm_config_userconfig`: npm, pnpm and yarn 1; yarn 2+ does
  not read an `.npmrc`). It never reaches the working copy nor the proposal, and the model only sees it
  masked. The registry's host must be among `OPENSHELL_REGISTRY_HOSTS`, and so must the host it redirects
  the download to: Azure Artifacts serves its packages from `<account>.blob.core.windows.net`. The code of the repository runs
  next to it, so the token is as exposed as on a developer's laptop: give it read access to the feed only.
- **Limits.** 10 minutes per script or command, so a `dev` or `watch` script is stopped; the agent reads the
  last 6,000 characters of the output; 300 MB copied per repository. The network is the policy above: no
  database, no Docker, no internal service, so a command cannot run integration tests that need them.
- **Live previews.** When OpenShell is configured, frontend development scripts (`dev`,
  `start` or `serve`) for React, Vue and Angular, and backend servers for Node.js, FastAPI/Flask/Django,
  Spring Boot/Quarkus/Micronaut, Go and .NET. Frontends use port 5173; backends use their configured port.
  Python requirements are installed from `requirements.txt` or `pyproject.toml`; Java build tools, Go and
  .NET restore dependencies when their development command starts. The default `node:24-bookworm-slim`
  image only contains Node.js: use `OPENSHELL_SANDBOX_TEMPLATE` or `OPENSHELL_SANDBOX_IMAGE` with the
  runtimes and build tools needed by your projects. Unknown or unsupported frameworks are not guessed.
  Changed files are synced into the sandbox, and preview links and the embedded frontend appear in
  **Edit with AI**. For domain edits, each conversation turn shows the previews of its repositories;
  backend previews are started when the agent finishes so frontends can call their APIs; select a
  frontend to switch the embedded view, and use the backend links to open APIs. Previews are enabled
  by default; set `OPENSHELL_PREVIEWS_ENABLED=false` to disable them. The preview process runs
  only until the sandbox is swept after the conversation is
  idle. OpenShell service URLs do not inherit Flightroom project authorization: anyone able to reach
  the gateway URL can reach the preview. Enable this only on a trusted, isolated gateway; disable it
  otherwise. The **View live preview** button in frontend and domain workspaces starts its own preview from the
  default branch, without an AI job (see [How it works](#how-it-works)); its URL is the sandbox's, not a
  deployed environment URL. Frontends that call a
  backend should use their normal local development proxy to the backend's configured port.

On Kubernetes, OpenShell needs the [Agent Sandbox](https://agent-sandbox.sigs.k8s.io) controller and a CNI
that enforces `NetworkPolicy`: without one, the network policy is not applied. Prefer a workload template
on the gateway (`OPENSHELL_SANDBOX_TEMPLATE`) with a gVisor or Kata runtime class and resource limits.

| Variable                         | Default                 | What it does                                                                     |
| -------------------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| `OPENSHELL_GATEWAY_URL`          |                         | The gateway. Unset, the agent is offered no tool that runs code.                 |
| `OPENSHELL_TOKEN`                |                         | An OIDC token already issued, sent as is: it expires, so prefer the client credentials below for a console that runs for days. |
| `OPENSHELL_OIDC_ISSUER`          |                         | With the client id and secret: a token from the client credentials grant, renewed before it expires. |
| `OPENSHELL_OIDC_CLIENT_ID`       |                         |                                                                                  |
| `OPENSHELL_OIDC_CLIENT_SECRET`   |                         |                                                                                  |
| `OPENSHELL_OIDC_AUDIENCE`        |                         |                                                                                  |
| `OPENSHELL_OIDC_SCOPES`          |                         | Space or comma separated.                                                        |
| `OPENSHELL_CA_CERT`              |                         | The gateway's CA as PEM text, for a container where mounting a file is a chore. It wins over the file. |
| `OPENSHELL_CA_CERT_FILE`         |                         | PEM file of the gateway's CA.                                                    |
| `OPENSHELL_CLIENT_CERT_FILE`     |                         | PEM client certificate and key, for a gateway that asks for mTLS (the local one does). |
| `OPENSHELL_CLIENT_KEY_FILE`      |                         |                                                                                  |
| `OPENSHELL_WORKSPACE`            | `default`               | The OpenShell workspace the sandboxes are created in.                            |
| `OPENSHELL_SANDBOX_TEMPLATE`     |                         | A workload template of the gateway: it wins over the image.                      |
| `OPENSHELL_SANDBOX_IMAGE`        | `node:24-bookworm-slim` | The image, without a template. It needs `sh`, `tar`, `find`, node, npm and corepack. |
| `OPENSHELL_SANDBOX_ROOT`         | `/sandbox`              | Where the copies and the caches live inside the sandbox.                         |
| `OPENSHELL_REGISTRY_HOSTS`       | npm, Maven, PyPI, Go, NuGet | Comma separated hosts the sandbox may reach on 443. Empty: the gateway's own policy. |
| `OPENSHELL_NETWORK_BINARY`       | Node, Java, Python, Go, .NET | Comma separated executables allowed to reach them: their real paths, not symlinks. |
| `OPENSHELL_SANDBOX_IDLE_MINUTES` | `5`                     | A sandbox is deleted once its conversation has been idle this long.              |
| `OPENSHELL_SANDBOX_OWNER`        | installation id         | The owner label of this installation's sandboxes. Set it apart on installations that share a gateway and were restored from one database. |
| `OPENSHELL_PREVIEWS_ENABLED`     | `true`                  | Starts and exposes development servers; set `false` to disable. Preview URLs are public to anyone who can reach the gateway. |

The SDK is published on GitHub Packages, which asks for a token even to read a public package. To build
the images yourself, pass one with `read:packages` as the build secret `npm_token`:
`docker build --secret id=npm_token,env=GITHUB_TOKEN .`

## Who can use it

Any member of the project can see the requests. Viewers can neither ask for a change nor apply or
discard one; organization administrators can. A request, a job and its follow-ups belong to the user who
started them: only they, or an organization administrator, can apply, discard, stop or follow them up, or
open their pull request. Other members see them read only (`AI_JOB_NOT_OWNER`). Requests count against `ASSISTANT_RATE_LIMIT_MAX`,
per user, like the assistant. The token usage of each request is stored and shown in the console, the jobs of
missions apart from the others; when its AI has configured token rates, the estimated cost, in the currency of
the AI (USD or EUR), is shown alongside it. With a sandbox the console also counts, by job, mission or live
preview, the scripts and commands run and how long they ran, and how long each sandbox lived from its creation
to its deletion, idle minutes included: a sandbox still alive is counted once it is deleted.
