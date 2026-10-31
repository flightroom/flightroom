# Flightroom Helm chart

Deploys [Flightroom](https://github.com/flightroom/flightroom) on Kubernetes. The chart installs
the standard image (`lory1990/flightroom`), which serves the frontend and the API behind nginx on
port `80`.

MongoDB and Redis are **not** deployed by this chart: point the application at instances you
already run, or install them with their own charts (example below).

## Install

Every release publishes the chart to the GitHub Container Registry as an OCI artifact, so no clone
is needed:

```bash
helm install flightroom oci://ghcr.io/flightroom/charts/flightroom --version 11.2.0 \
  --namespace flightroom --create-namespace \
  --set env.NOSQL_DATABASE_URL="mongodb://root:example@mongodb:27017" \
  --set env.REDIS_URL="redis://redis:6379" \
  --set envSecrets.JWT_SECRET="$(openssl rand -hex 32)"
```

Without `--version` Helm takes the latest chart. `helm show values oci://ghcr.io/flightroom/charts/flightroom`
prints the default values of a version.

Argo CD reads the same registry once it is registered as a Helm repository with OCI enabled
(`argocd repo add ghcr.io/flightroom/charts --type helm --name flightroom --enable-oci`, or the
equivalent repository Secret with `enableOCI: "true"`). The `Application` then takes the registry
without the `oci://` scheme and without the chart name:

```yaml
spec:
  source:
    repoURL: ghcr.io/flightroom/charts
    chart: flightroom
    targetRevision: 11.2.0
    helm:
      valuesObject:
        env:
          NOSQL_DATABASE_URL: mongodb://root:example@mongodb:27017
```

From a clone of the repository, use the path instead: `helm install flightroom ./helm/flightroom ...`.

### Upgrading from the `mfe-orchestrator` chart

Chart `0.3.0` renamed the chart from `mfe-orchestrator` to `flightroom`. The name is part of the
Deployment selector and of every resource name, so `helm upgrade` of an existing release creates new
resources and deletes the old ones — **the PersistentVolumeClaim of the uploaded bundles included**.
To keep the bundles, tell Helm to leave the old claim in place and mount it from the new chart:

```bash
kubectl annotate pvc <release>-mfe-orchestrator-microfrontends helm.sh/resource-policy=keep
helm upgrade <release> oci://ghcr.io/flightroom/charts/flightroom --version 11.2.0 -f my-values.yaml \
  --set persistence.existingClaim=<release>-mfe-orchestrator-microfrontends
```

(the claim is named `mfe-orchestrator-microfrontends` when the release itself was called
`mfe-orchestrator`). The Service changes name too: update the ingress backends, port-forwards and
anything else that addressed it.

Useful commands:

```bash
helm lint helm/flightroom
helm template flightroom helm/flightroom -f my-values.yaml
helm test flightroom                   # hits /api/echo from inside the cluster
helm upgrade flightroom oci://ghcr.io/flightroom/charts/flightroom -f my-values.yaml
```

## Environment variables

Every variable can be set from `values.yaml`, and any variable not
listed there can simply be added to the same maps:

| Values key       | Rendered as                     | Use for                                              |
| ---------------- | ------------------------------- | ---------------------------------------------------- |
| `env`            | ConfigMap `<release>-env`       | plain configuration                                  |
| `envSecrets`     | Secret `<release>-env`          | passwords, client secrets, JWT key                   |
| `existingSecret` | `envFrom.secretRef` list        | secrets managed outside of the chart (sealed, ESO …) |
| `existingConfigMap` | `envFrom.configMapRef` list  | configuration managed outside of the chart           |
| `extraEnv`       | container `env` entries         | `valueFrom` references (secret keys, field refs)     |

Both maps accept native YAML scalars — values are quoted when rendered, so `EMAIL_SMTP_PORT: 587`
and `REGISTRATION_ALLOWED: true` are fine. An **empty or null value is skipped entirely**, so the
variable is not injected and the application keeps its own default.

```yaml
env:
  NODE_ENV: prod
  FRONTEND_URL: https://console.example.com
  BACKEND_URL: https://console.example.com/api
  REGISTRATION_ALLOWED: false
  NOSQL_DATABASE_URL: mongodb://root:example@mongodb:27017
  REDIS_URL: redis://redis:6379
  # anything else the app reads can be added here
  MY_FUTURE_VARIABLE: value

envSecrets:
  JWT_SECRET: a-32-bytes-random-string
  NOSQL_DATABASE_PASSWORD: example

existingSecret:
  - flightroom-credentials

extraEnv:
  - name: GOOGLE_CLIENT_SECRET
    valueFrom:
      secretKeyRef:
        name: google-oauth
        key: client-secret
```

Precedence, from lowest to highest: `env` → `envSecrets` → `existingConfigMap` → `existingSecret`
→ `extraEnv` (Kubernetes applies `env` after every `envFrom` source).

### Variables shipped in `values.yaml`

Core: `NODE_ENV`, `PORT`, `FRONTEND_URL`, `BACKEND_URL`, `ALLOWED_ORIGINS`,
`ALLOWED_SERVE_ORIGINS`, `MICROFRONTEND_HOST_FOLDER`, `REGISTRATION_ALLOWED`,
`ALLOW_EMBEDDED_LOGIN`, `RATE_LIMIT_MAX`, `INSTALLATION_NAME`, `INSTALLATION_LOGO_URL`,
`MARKETING_OPT_IN_ENABLED`, `MARKETING_OPT_IN_VERSION`

`RATE_LIMIT_MAX` ships commented out in `values.yaml` on purpose: it is validated as
`type: number`, and an empty value fails that validation and keeps the container from
starting. Uncomment it only to set a real number (the application default is `100`).
`MCP_RATE_LIMIT_MAX` is commented out for the same reason (the application default is `120`).

MongoDB: `NOSQL_DATABASE_URL`, `NOSQL_DATABASE_NAME`, `NOSQL_DATABASE_USERNAME`,
`NOSQL_DATABASE_PASSWORD`*

Redis: `REDIS_URL`, `REDIS_PASSWORD`*

SMTP: `EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT`, `EMAIL_SMTP_SECURE`, `EMAIL_SMTP_USER`,
`EMAIL_SMTP_FROM`, `EMAIL_SMTP_PASSWORD`*

Auth: `JWT_SECRET`*, `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_AUDIENCE`, `AUTH0_SCOPE`,
`AZURE_ENTRAID_TENANT_ID`, `AZURE_ENTRAID_CLIENT_ID`, `AZURE_ENTRAID_REDIRECT_URI`,
`AZURE_ENTRAID_AUTHORITY`, `AZURE_ENTRAID_SCOPES`, `AZURE_ENTRAID_API_AUDIENCE`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`*, `GOOGLE_REDIRECT_URI`,
`GOOGLE_AUTH_SCOPE`, `GOOGLE_AUTH_HOSTED_DOMAIN`, `GOOGLE_API_AUDIENCE`

Code repositories: `CODE_REPOSITORY_GITHUB_CLIENT_ID`, `CODE_REPOSITORY_GITHUB_CLIENT_SECRET`*

Stored credentials: `SECRETS_ENCRYPTION_KEY`* — encrypts bucket keys and repository tokens at rest,
see [docs/SECRETS.md](../../docs/SECRETS.md). Back it up apart from the database: without it the
encrypted credentials cannot be read back.

Dependencies: `NPM_REGISTRY_URL`

Remote MCP server: `MCP_ENABLED`, `MCP_API_KEY_ENABLED`, `MCP_DCR_ENABLED`, `MCP_CIMD_ENABLED`, `CIMD_ALLOWED_HOSTS`,
`OAUTH_ISSUER_URL`, `MCP_RESOURCE_URL`, `TRUST_PROXY` — see [docs/MCP.md](../../docs/MCP.md). With
`MCP_ENABLED` the backend refuses to start without `FRONTEND_URL` and without a `JWT_SECRET` of at
least 32 bytes (`openssl rand -hex 32`). Behind an ingress, set `TRUST_PROXY` to the hops you run
(e.g. `loopback,10.0.0.0/8` for the in-pod nginx plus ingress pods in the pod CIDR; a hop count is refused):
otherwise every client is seen with the ingress controller's IP and shares one rate limit bucket. Behind an ingress
the discovery documents must reach the pod too: the default `path: /` already routes
`/.well-known/oauth-*` there.

Observability: `SENTRY_DSN`, `TELEMETRY_ENABLED`, `TELEMETRY_DISABLED`, `TELEMETRY_ENDPOINT`,
`TELEMETRY_INTERVAL_HOURS`, `DO_NOT_TRACK`

Not shipped, add them yourself: the AI provider variables (`AI_PROVIDER`, `ANTHROPIC_API_KEY`, …),
`AI_MAX_EFFORT`, `ASSISTANT_RATE_LIMIT_MAX`, `ARGOCD_ALLOW_INSECURE_HTTP`, `REPOSITORIES_*` and
`OPENSHELL_*`. Put API keys under `envSecrets`.

`*` lives under `envSecrets`. The meaning and defaults of each variable are documented in the
[root README](../../README.md#environment-variables-) and in the comments of `values.yaml`.

### Image version

`image.tag` defaults to the chart's `appVersion`, so a plain install runs the version the chart
was released with: the release workflow refuses a tag that does not match `appVersion`. Override it
to pin a different one:

```yaml
image:
  tag: "5.1.0"
```

Use the standard image, not the `-all-in-one` tag: the chart expects MongoDB and Redis outside the
pod.

## Storage

Uploaded frontend bundles are stored on a PersistentVolumeClaim mounted at
`env.MICROFRONTEND_HOST_FOLDER` (default `/upload-microfrontends`). Setting
`persistence.mountPath` overrides the mount point and the variable is kept in sync automatically.

```yaml
persistence:
  enabled: true
  size: 20Gi
  storageClass: fast-rwo
  # existingClaim: my-claim
```

With `persistence.enabled: false` the frontend bundles live in the container filesystem and are
lost at every restart.

### AI repository clones

The repositories edited with AI are cloned under `repositories.mountPath` (default `/repositories`;
the chart sets `REPOSITORIES_FOLDER` to it). It is a cache, so it is an `emptyDir` capped at
`repositories.sizeLimit` unless `repositories.existingClaim` names a PVC that keeps the clones across restarts.

### More than one replica

A `ReadWriteOnce` volume attaches to a single node, so a second pod scheduled elsewhere never
mounts it. The chart therefore:

- **fails the render** when `replicaCount > 1` or `autoscaling.enabled` is combined with a volume
  whose `persistence.accessModes` lack `ReadWriteMany`;
- uses the **`Recreate` strategy** on such a volume, unless `strategy.type` is set: a rolling update
  starts the new pod before stopping the old one, and if the new pod lands on another node it waits
  for the volume forever and the upgrade hangs.

To run several replicas, use a StorageClass that provides `ReadWriteMany` (NFS, Azure Files,
Amazon EFS, CephFS …). The strategy then defaults to a rolling update with `maxUnavailable: 0`:

```yaml
replicaCount: 2
persistence:
  storageClass: azurefile-csi
  accessModes:
    - ReadWriteMany
```

With `persistence.existingClaim`, set `persistence.accessModes` to the access modes of that claim:
the chart cannot read them.

## Ingress

```yaml
ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: 50m
  hosts:
    - host: console.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: flightroom-tls
      hosts:
        - console.example.com
```

Remember to align `env.FRONTEND_URL` (and `env.BACKEND_URL`, which defaults to
`<FRONTEND_URL>/api`) with the public hostname.

## MongoDB and Redis

Example with the Bitnami charts, installed alongside this one:

```bash
helm install mongodb oci://registry-1.docker.io/bitnamicharts/mongodb \
  --set auth.rootPassword=example
helm install redis oci://registry-1.docker.io/bitnamicharts/redis \
  --set auth.enabled=false

helm install flightroom oci://ghcr.io/flightroom/charts/flightroom \
  --set env.NOSQL_DATABASE_URL="mongodb://root:example@mongodb:27017" \
  --set env.REDIS_URL="redis://redis-master:6379"
```

## Values reference

| Key                            | Default                  | Description                                              |
| ------------------------------ | ------------------------ | -------------------------------------------------------- |
| `replicaCount`                 | `1`                      | Number of pods (ignored when autoscaling is enabled); above `1` needs a `ReadWriteMany` volume |
| `image.repository`             | `lory1990/flightroom`    | Image repository                                         |
| `image.tag`                    | `""`                     | Image tag, defaults to the chart `appVersion`            |
| `image.pullPolicy`             | `IfNotPresent`           | Image pull policy                                        |
| `imagePullSecrets`             | `[]`                     | Pull secrets for private registries                      |
| `nameOverride`                 | `""`                     | Override the chart name in the generated names           |
| `fullnameOverride`             | `""`                     | Override the full resource name entirely                 |
| `env`                          | see `values.yaml`        | Plain environment variables                              |
| `envSecrets`                   | see `values.yaml`        | Sensitive environment variables                          |
| `existingSecret`               | `[]`                     | Existing Secrets injected with `envFrom`                 |
| `existingConfigMap`            | `[]`                     | Existing ConfigMaps injected with `envFrom`              |
| `extraEnv`                     | `[]`                     | Raw container `env` entries                              |
| `persistence.enabled`          | `true`                   | Persist uploaded frontend bundles on a PVC              |
| `persistence.existingClaim`    | `""`                     | Use an existing PVC instead of creating one              |
| `persistence.storageClass`     | `""`                     | StorageClass (`-` disables dynamic provisioning)         |
| `persistence.accessModes`      | `[ReadWriteOnce]`        | PVC access modes; `ReadWriteMany` for more than one pod  |
| `persistence.size`             | `8Gi`                    | PVC size                                                 |
| `persistence.mountPath`        | `""`                     | Mount point, defaults to `MICROFRONTEND_HOST_FOLDER`     |
| `persistence.subPath`          | `""`                     | Sub path of the volume to mount                          |
| `persistence.annotations`      | `{}`                     | Annotations added to the PVC                             |
| `repositories.mountPath`       | `/repositories`          | Where the AI repository clones live                      |
| `repositories.sizeLimit`       | `10Gi`                   | Size limit of the clones `emptyDir`                      |
| `repositories.existingClaim`   | `""`                     | PVC for the clones instead of the `emptyDir`             |
| `service.type`                 | `ClusterIP`              | Service type                                             |
| `service.port`                 | `80`                     | Service port                                             |
| `service.nodePort`             | `""`                     | Node port when `service.type` is `NodePort`              |
| `service.annotations`          | `{}`                     | Annotations added to the Service                         |
| `ingress.enabled`              | `false`                  | Create an Ingress                                        |
| `ingress.className`            | `""`                     | Ingress class                                            |
| `ingress.hosts`                | `flightroom.local`       | Ingress hosts and paths                                  |
| `ingress.tls`                  | `[]`                     | Ingress TLS configuration                                |
| `serviceAccount.create`        | `true`                   | Create a ServiceAccount                                  |
| `serviceAccount.automount`     | `true`                   | Automount the API credentials in the pod                 |
| `resources`                    | `{}`                     | Container resource requests/limits                       |
| `livenessProbe.enabled`        | `true`                   | HTTP liveness probe on `/api/echo`                       |
| `readinessProbe.enabled`       | `true`                   | HTTP readiness probe on `/api/echo`                      |
| `startupProbe.enabled`         | `false`                  | HTTP startup probe on `/api/echo`                        |
| `autoscaling.enabled`          | `false`                  | Create a HorizontalPodAutoscaler                         |
| `autoscaling.minReplicas`      | `1`                      | Lower bound of the HorizontalPodAutoscaler               |
| `autoscaling.maxReplicas`      | `5`                      | Upper bound of the HorizontalPodAutoscaler               |
| `restartOnConfigChange`        | `true`                   | Roll the pods when env ConfigMap/Secret change           |
| `strategy.type`                | `""`                     | `Recreate` on a volume without `ReadWriteMany`, `RollingUpdate` otherwise |
| `strategy.rollingUpdate`       | `maxSurge: 1`, `maxUnavailable: 0` | Rolling update parameters                      |
| `podAnnotations` / `podLabels` | `{}`                     | Extra pod metadata                                       |
| `commonLabels` / `commonAnnotations` | `{}`               | Metadata added to every resource                         |
| `podSecurityContext` / `securityContext` | `{}`           | Security contexts                                        |
| `nodeSelector` / `tolerations` / `affinity` | `{}`/`[]`/`{}` | Scheduling constraints                                 |
| `topologySpreadConstraints`    | `[]`                     | Topology spread constraints                              |
| `priorityClassName`            | `""`                     | PriorityClass of the pods                                |
| `terminationGracePeriodSeconds`| `30`                     | Graceful shutdown period                                 |
| `extraVolumes` / `extraVolumeMounts` | `[]`               | Additional volumes and mounts, e.g. the installation theme ([docs/THEMES.md](../../docs/THEMES.md)) |
| `extraInitContainers` / `extraContainers` | `[]`          | Additional containers                                    |
