# Argo CD

With GitOps turned on, every deploy commits what it ships to the repositories of the project: the
Namespace, the config maps and the secrets of each environment to the configuration repository, and
the Helm values of each application to the applications repository. **Initialize Argo CD**, in the
settings of the project, hands those repositories to an Argo CD you already run, so that what is
committed is what the cluster runs. Only an owner of the project, or an administrator of its
organization, initializes it; the other members see its status.

Argo CD stays where it is, on its own cluster. The console never touches that cluster: it talks to the
Argo CD API, `https://<argocd>/api/v1`, with the token of an account made for it, and every
environment is deployed to the cluster Argo CD runs in (`https://kubernetes.default.svc`).

## Requirements

- **Argo CD 2.8 or later** is required: the ApplicationSets use Go templates, a sync policy of their
  own, and a matrix generator whose git generator takes its revision from the list generator before it.
- The ApplicationSet controller allows a policy per ApplicationSet (see
  [the applications are never deleted](#the-applications-are-never-deleted-by-their-applicationset)).

## What it creates

All of it is labelled `app.kubernetes.io/managed-by: flightroom` and
`flightroom/project-id: <project id>`. Every name below starts with `fr-` and ends with `<hash>`, a hash of the
project id, so two projects with the same slug, in two organizations, never meet. `<slug>` is the project slug.

| Object | Name | What it does |
| --- | --- | --- |
| AppProject | `fr-<slug>-<hash>` | Lets the applications of the project read its two repositories only, and write only to the namespaces of its environments. Namespace is the one cluster-wide kind it may create. |
| Repository credentials | one per repository | Read-only, over HTTPS. Those of the configuration repository, which holds the secrets in plaintext, are scoped to the AppProject. Those of the applications repository, which holds Helm values only, are global: the git generator of an ApplicationSet reads the repository outside of any AppProject. |
| ApplicationSet | `fr-<slug>-environments-<hash>` | Lists the environments of the project. Argo CD makes from it an Application per environment, `fr-<slug>-<environment>-<hash>`, syncing the folder `<environment>/` (its `namespace.yaml`, `configMaps/*.yaml` and `secrets/*.yaml`) from the default branch of the configuration repository into the namespace of the environment. Automated, with prune and self-heal. The environments are listed rather than found in the repository: a git generator would read the configuration repository outside of the AppProject, and it holds the secrets. |
| ApplicationSet | `fr-<slug>-<application>-<hash>` | Only with an applications repository, one per backend and per frontend that runs as a container, once it has a version and an image: its own, or `<containerRegistry>/<application>` when the project has a container registry. An image of its own that is a bare name, with no `/`, is taken in that registry too: `<containerRegistry>/<name>`. Makes an Application per environment, `fr-<slug>-<application>-<environment>-<hash>`, for every environment whose branch holds `<application>.yaml`, installed with `microservice-chart/` of that branch and `../<application>.yaml` as values file. An environment whose branch does not exist yet is left out of the list: Argo CD fails an ApplicationSet that names a revision it cannot find. Labelled `flightroom/application: <application>`. |

> **Never put a secret in the Helm values.** The applications repository is registered globally, so
> every AppProject of the Argo CD instance may read it. Secrets belong in the secrets of the project,
> committed to the configuration repository.

Every name fits 63 characters, as Argo CD tracks resources with it in a label: a name that would not fit
is cut and ends with a hash. For example, the Application of `orders-api` in `dev`, in the project `shop`, is `fr-shop-orders-api-dev-1a2b3c`. The Helm release of an application is its slug, and Helm refuses a release
name longer than **53 characters**: an application with a longer slug fails to sync, with that error in
Argo CD. Keep the slugs of backends and frontends shorter.

Before writing anything, the console checks that every name it is about to take is free or already its
own, and that no repository it registers is already registered in Argo CD by someone else. An object
the account of the token may not read counts as taken. Anything taken stops the initialization with
nothing changed: rename or remove it in Argo CD, then initialize again. Two objects of the project
that would take the same name stop it too: `orders-api` in `dev` and `orders` in `api-dev` are both
`fr-<slug>-orders-api-dev-<hash>`, and a backend named `environments` would take the ApplicationSet of the
environments. Rename one of them.

### The repositories in Argo CD

Under **Settings → Repositories**, Argo CD lists the two repositories of a project, without a name, and
only one of them in a project:

| Repository | Project column | Why |
| --- | --- | --- |
| Configuration | `fr-<slug>-<hash>` | It holds the secrets in plaintext: only the applications of the AppProject may read it. |
| Applications | empty | The ApplicationSet of each backend and frontend finds the branches and the values files with a git generator. The ApplicationSet controller runs that generator outside of any AppProject, so it reads only global credentials. |

An applications repository with an empty project is expected: nothing is missing. When two projects of
the organization link the same applications repository, they share one global registration. The second
project adds no row, and the registration stays as long as a project reads through it. A project column
without the `fr-` prefix is an AppProject of 10.x: initialize that project again to move it (see
[Re-running it](#re-running-it)).

### The Namespace is never pruned

The Namespace manifest the console commits carries
`argocd.argoproj.io/sync-options: Prune=false,Delete=false`: the applications of the environment run in
it, and a configuration repository emptied by mistake, or the Application of an environment deleted, must
not take them down with it.

### The applications are never deleted by their ApplicationSet

Each ApplicationSet carries `syncPolicy.applicationsSync: create-update`: it creates and updates its
applications, and never deletes one. Were the values file of a backend wiped from a branch by mistake,
its application in that environment would otherwise go with it, and its workloads with it. An
application whose values file is gone for good is deleted by hand in Argo CD.

Argo CD honours that field only when the ApplicationSet controller allows a policy per ApplicationSet.
Set it in `argocd-cmd-params-cm`, or set the same policy for the whole controller:

```yaml
data:
  applicationsetcontroller.enable.policy.override: "true"
  # or, for every ApplicationSet:
  # applicationsetcontroller.policy: create-update
```

### Re-running it

Initializing again re-aligns Argo CD with the project: **after adding or deleting an environment, or
changing the GitOps repositories, initialize again.** Between two initializations every deploy upserts
the ApplicationSet of each backend and frontend, so a backend deployed for the first time gets its
Applications without one. Then it refreshes the Applications of the environments it deployed, so they
sync what it committed right away instead of at the next poll of Argo CD, three minutes by default; an
Application the ApplicationSet has yet to generate comes with the next poll of the ApplicationSet. A
refresh that fails is only logged: the Applications sync at the next poll anyway.
A deploy that cannot align Argo CD still goes through, and why shows in the
settings, apart from the errors of the initialization; the next deploy that aligns it clears it. A deploy
does not align while an initialization runs, nor when Argo CD was handed another applications repository
or its AppProject is not there: it asks for an initialization instead. A new
environment waits for an initialization too: its namespace joins the AppProject only then, and until
then the deploys leave it out of the ApplicationSets. One
initialization of a project runs at a time. One that has not saved anything for five minutes is taken
for dead and the next may start; should the first come back, it stops instead of overwriting what the
second stored.

- The new environments join the list of `fr-<slug>-environments-<hash>` and of the ApplicationSet of every
  backend and frontend, once their branch exists.
- Those of the environments that no longer exist leave the lists, and Argo CD deletes the Application of
  each: `fr-<slug>-environments-<hash>` has `preserveResourcesOnDeletion`, so what it deployed stays in the
  cluster until you remove it; the Applications of the backends were never deleted by their ApplicationSet
  and are left, to delete by hand.
- The ApplicationSet of a backend or frontend that no longer exists is deleted, and with it, through their
  owner references, the Applications it generated; their workloads stay, as the generated Applications
  carry no finalizer.
- What 10.0 and 10.1 made, named without the `fr-` prefix in the AppProject `<slug>-<hash>`, moves to the
  names of now: the ApplicationSets there are deleted once the new ones are in, their Applications with them
  and without cascade, so the workloads stay and the new Applications take them over; the configuration
  repository is registered for the new AppProject, and the old AppProject is deleted. Argo CD refuses that
  last deletion while Applications still belong to it: the next initialization tries again. Until a project
  is initialized again, its deploys still sync through the old Applications, but they no longer align its
  ApplicationSets (the settings ask for an initialization), and the console finds neither the pods, the
  logs nor the rollout of its applications. The Gateway of each environment keeps its name, `<slug>-<hash>`.
- The credentials of a repository no longer linked, or linked at another URL, are deleted from Argo CD,
  and its GitLab deploy token is revoked through the connection that created it. A deletion Argo CD
  refuses is remembered, without the credentials, and tried again by the next initialization.

### Moving to another Argo CD

Pointing the project at another URL asks for the Argo CD token and the repository token again: the
stored ones never go to another server. What the console created on the old instance is left there,
because the console no longer trusts an instance it was moved away from: remove the AppProject, the
Applications, the ApplicationSets and the repository credentials by hand. The GitLab deploy tokens the
old instance read with are revoked anyway, on GitLab, so the old instance can no longer clone; a GitHub
or Azure DevOps token you pasted is yours to revoke.

### Maintenance agents

A maintenance agent is deployed like a backend, with its values file on the branch of each environment,
and gets a CronJob from `templates/cronjob.yaml` of the chart. The template is written as a file of its
own, so the branches whose chart predates it get it with their next deploy; the rest of the chart is left
as the team changed it.

- **job**: the CronJob runs the image of the agent, and its Deployment has no replicas.
- **container**: the Deployment runs as for a backend, and the CronJob POSTs to the run path of the agent
  (`http://<slug>/run` by default) with `curlimages/curl`.

Without a schedule the CronJob is suspended. Play in the console asks Argo CD to run the `create-job`
action on it, which creates a Job right away, for both kinds and whatever the schedule. The rule
`applications, *, fr-*/*` below already allows it. An account given narrower rules needs
`applications, action/batch/CronJob/create-job, fr-*/*`.

The backends and frontends the agent maintains reach its container as JSON in `MAINTAINED_TARGETS`, with
the URL inside the namespace of those that run as a container. A backend keeps `"kind": "service"` in that
JSON, the name the containers of the agents already read.

The agent can read the logs and the builds of those targets through the console API. Every deploy writes
`<environment>/maintenanceAgents/<slug>.yaml` in the configuration repository: a Secret
`<slug>.flightroom` its container reads, with `FLIGHTROOM_API_URL`, where the console API answers, and
`FLIGHTROOM_AGENT_TOKEN`, the token of the agent in that environment, minted at its first deploy there and
kept from one deploy to the next. Sent as `Authorization: Bearer <token>`, it reads only the targets of the
agent, and only in the environment it was minted for:

| Request | What it returns |
| --- | --- |
| `GET /maintenance-agent-runtime/targets` | the targets, each with `logs` (it runs as a container) and `builds` (it has a code repository) |
| `GET /maintenance-agent-runtime/targets/<slug>/pods` | the pods of the target in the environment, through Argo CD |
| `GET /maintenance-agent-runtime/targets/<slug>/logs?pod=<pod>` | the last lines of a pod, with `tailLines` (500, at most 5000), `sinceSeconds`, `previous` and `filter` as the console reads them |
| `GET /maintenance-agent-runtime/targets/<slug>/builds` | the latest runs of its CI |
| `GET /maintenance-agent-runtime/targets/<slug>/builds/<runId>/logs` | the logs of the failed jobs of one run |

The token is in the configuration repository as the other Secrets are, base64 encoded and not encrypted:
whoever reads that repository can read those logs. The pod logs need the project deployed through Argo
CD; the builds, a code repository on the target.

If a token leaves the configuration repository, revoke it: **Revoke tokens** in the danger zone of
the agent, `POST /maintenance-agents/<id>/revoke-tokens` (with an optional `environmentId`), or the
MCP tool `maintenance_agent_tokens_revoke`. It is refused from then on, and the next deploy of each
environment writes a new one: a container reads it when its pod restarts, a job at its next run.
Deleting the agent revokes its tokens too.

## Network

The backend of the orchestrator opens HTTPS connections to the Argo CD API. Nothing goes the other way:
Argo CD reads the repositories from the Git provider, not from the orchestrator.

- The URL must be reachable from the pods of the orchestrator: through an Ingress, a load balancer or a
  private link between the clusters.
- It must be https. `ARGOCD_ALLOW_INSECURE_HTTP=true` on the backend allows http, for a local cluster
  only: the token and the repository credentials would cross the network in the clear.
- Redirects are not followed: use the URL Argo CD answers at, not one that redirects to it.
- The certificate must be one Node trusts. A private CA goes in `NODE_EXTRA_CA_CERTS` of the backend.
  For a self-signed certificate, tick "Accept self-signed certificates" in the Argo CD settings of the
  project: the certificate is not verified, as with `argocd --insecure`, so only over a network you trust.
- The URL is the one of the Argo CD server, without `/api/v1`: `https://argocd.example.com`.

## The Argo CD account

The console acts as a local account of Argo CD, with an API key and no password. Add it to
`argocd-cm`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  accounts.orchestrator: apiKey
```

Give it only what it needs, in `argocd-rbac-cm`. Everything the console creates starts with `fr-`, so
the AppProjects, the Applications and the ApplicationSets it may touch are only its own:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  policy.csv: |
    p, role:orchestrator, projects, *, fr-*, allow
    p, role:orchestrator, applications, *, fr-*/*, allow
    p, role:orchestrator, applicationsets, *, fr-*/*, allow
    p, role:orchestrator, logs, get, fr-*/*, allow
    p, role:orchestrator, repositories, *, *, allow
    g, orchestrator, role:orchestrator
```

Upgrading from 10.0 or 10.1, whose objects have no prefix: add the `fr-*` lines and keep the rules the
account had until every project is initialized again, as that initialization reads and deletes the objects
of the old names. A project whose old AppProject the account can no longer read stops with "Not allowed".

The `logs` line lets the console show the logs of the pods on the pages of the backends and frontends.
An installation set up before it answers those with a permission error until the line is added.

The repositories cannot be narrowed the same way: the RBAC object of a global repository is its URL,
and the applications repository is registered globally.

Then generate its token, and paste it in the settings of the project:

```bash
argocd account generate-token --account orchestrator
```

The token is checked against `/api/v1/session/userinfo` before anything is written. It is stored
encrypted (see [SECRETS.md](SECRETS.md)) and never sent back to the browser.

## Repository credentials

Argo CD reads the repositories with credentials of its own, read-only, never with the token of the
connection of the project, which can write.

| Provider | What to do |
| --- | --- |
| GitLab | Nothing. The console creates a project deploy token with the `read_repository` scope on each repository, and on every initialization creates a new one, hands it to Argo CD, and only then revokes the one before. The token of the connection needs the **Maintainer** role on the repositories and the `api` scope. |
| GitHub | A fine-grained personal access token with **Contents: Read-only** on the two repositories. |
| Azure DevOps | A personal access token with **Code: Read**. |

GitHub and Azure DevOps cannot create a token through their API, so the settings ask for one, used for
every repository that is not on GitLab. It is required on the first initialization and whenever the URL
changes; otherwise, leave it empty to keep the stored one. Like the Argo CD token, it is stored encrypted
and never returned.

## When it fails

The error is shown in the settings and kept on the project until an initialization goes through. What
it says to check:

| Error | What to check |
| --- | --- |
| Not reachable | The URL, the DNS name, and that the orchestrator cluster can reach the Argo CD API. |
| Certificate not trusted | The certificate of Argo CD, `NODE_EXTRA_CA_CERTS`, or "Accept self-signed certificates" for a self-signed one. |
| Token not accepted | That it is a token of the `orchestrator` account, not expired or revoked. |
| Not allowed | The policy in `argocd-rbac-cm` above. |
| Name taken | An AppProject, Application or ApplicationSet of that name not created by this project. |
| Repository already registered | A registration of the repository made by hand, or by another project. |
| Deploy token not created | The role and the scopes of the GitLab connection. |
| Initialized with other repositories, or AppProject not there | Nothing: initialize again. |
| Already running | Another initialization of the project: wait for it to end. |
