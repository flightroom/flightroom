# Editing a frontend with AI

From **Edit with AI**, the screen a frontend opens on, a user describes a change ("add a 404 page"). An
AI agent works on a local clone of the frontend's repository and proposes the change as a diff.
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

It is available when an [AI provider](AI-PROVIDERS.md) is configured and the frontend has a
code repository connected (GitHub, GitLab or Azure DevOps).

## How it works

1. The request is stored and a background job starts; the console follows it by polling.
2. The job takes a lock on the frontend's working copy (Redis, or in-process without Redis), so
   two requests on the same repository queue instead of sharing a checkout.
3. The working copy is cloned if missing, otherwise fetched and reset to `origin/<base branch>`:
   every run starts from exactly what the remote has.
4. The agent explores and edits the files. It receives the [project and frontend context](MCP.md#project-context)
   and the detected stack.
5. The changed files are committed on the conversation's feature branch,
   `ai/<frontend>-<timestamp>` (author: the user who asked, committer: Flightroom), on top of
   the base the agent started from, and force-pushed. A follow-up that only answers a question, without
   changing a file, pushes nothing. A push that fails does not lose the proposal: the console shows the
   error, and applying it or opening its pull request pushes it again.
6. The changed files (original and proposed content) are stored as a proposal, the working copy is
   reset and the lock released. Proposals nobody acts upon are removed after 7 days; their branch stays.
7. On **Apply** the copy is reset to the latest base again and every file is checked to still be what
   the agent saw. A file changed on the base branch in the meantime stops the apply with a conflict,
   so nothing is silently overwritten. When the base has not moved since the proposal, the base
   fast-forwards to the very commit of the feature branch, so a pull request opened on it reads merged;
   otherwise the files are committed again on top of the latest base. The push is never forced: a
   protected base branch refuses it, and the console suggests opening a pull request instead. The
   feature branch is then deleted, unless a pull request is open on it.
8. On **Open a pull request** the provider opens it from the feature branch onto the base. If it refuses
   (for example a token without that permission), the console shows why and the branch stays pushed.

Clone, fetch, commit and push use [isomorphic-git](https://isomorphic-git.org): no `git` binary is
needed in the image, and no repository hook is ever run.

## Changing a whole domain

**Edit with AI** on a functional domain starts one agent on every frontend and service of the
domain that has a code repository (at most 10), with the project and domain context. It sees them all
at once, so one change can span an API and the screens that call it, and it still proposes one diff
per repository, each on its own feature branch, applied or opened as a pull request on its own. Each
repository starts from the branch picked for it, its default branch otherwise; one choice sets them all at
once, either back to their own default branches or to a branch every one of them has. Each message of the conversation shows
one tab per repository, with its own files and diff, opened on the first proposal to review. Members without
a repository are left out and listed under the request.

When the domain has nothing for the agent to work on yet, **Generate** first offers to create it:

- **No frontend and no service:** one model call proposes the components the request needs
  (usually a frontend and a backend, at most 3 of each), each with a name, a slug, a template and a
  repository name ending in `-fe` or `-be`. The user reviews and edits the proposal; on confirmation
  the console creates each one in the domain with a new repository scaffolded from its template, then
  starts the job on them.
- **Members, none with a repository:** the console asks to create one per member (named
  `<slug>-fe` or `<slug>-be`, scaffolded from the member's template or the default of its kind), then
  starts the job.

Both need a code repository connection on the project. Creating a repository for an existing member
is also available as `POST /frontends/:id/repository` and `POST /services/:id/repository`;
viewers cannot use it.

## Fleet: missions on many repositories

The **Fleet** page sends one request ("upgrade React to 19") to many repositories at once: every
frontend and service of the project with a code repository, or the ones picked from the list. This is
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
- A running mission takes one of the 3 places for AI work at once in a project, however many jobs it
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
  lockfiles: a pushed branch runs CI with the repository secrets. Since every proposal is pushed on its
  feature branch as soon as the agent is done, a pipeline that runs on every branch runs on the
  agent's code before anyone has reviewed it: limit such pipelines, or their secrets, to protected branches.
- It cannot run anything: no install, build or test. The repository's CI checks the pull request.
- It is told the config maps, secrets and resources attached to each service by the names of their
  variables, never a credential (see [SECRETS](SECRETS.md#in-the-api)). When a service attaches an `api`
  resource it gets `read_api_spec`, which reads the OpenAPI document pasted in the console, or fetches its
  `specUrl` from the backend with no access to private addresses, and answers with an index of the
  operations or one operation in full.
- At most 20 files and 500 KB written per request, 40 model rounds.
- It never pushes. The console pushes its proposal on a feature branch only, never on the base branch:
  only the user's **Apply** writes there.

## Who can use it

Any member of the project can see the requests. Viewers can neither ask for a change nor apply or
discard one; organization administrators can. A request, a job and its follow-ups belong to the user who
started them: only they, or an organization administrator, can apply, discard, stop or follow them up, or
open their pull request. Other members see them read only (`AI_JOB_NOT_OWNER`). Requests count against `ASSISTANT_RATE_LIMIT_MAX`,
per user, like the assistant. The token usage of each request is stored and shown in the console.
