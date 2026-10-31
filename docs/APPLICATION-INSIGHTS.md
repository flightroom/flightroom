# Application Insights 🔭

Flightroom can send the telemetry of what it deploys, and of the console itself, to an
[Azure Monitor Application Insights](https://learn.microsoft.com/azure/azure-monitor/app/app-insights-overview)
resource **you** own. Nothing is sent anywhere unless you give it a connection string, and what is sent goes to
your resource only: this has nothing to do with the [anonymous telemetry](TELEMETRY.md) ping.

There are three independent pieces:

| What                           | How you turn it on                                                             | Where it shows up               |
| ------------------------------ | ------------------------------------------------------------------------------ | ------------------------------- |
| Your backends                  | Attach an **Application Insights** resource to the backend                      | One node per backend            |
| Your microfrontends (browser)  | Set the global variable `APPLICATIONINSIGHTS_CONNECTION_STRING` in the environment | One node per host application   |
| The Flightroom console         | Set `APPLICATIONINSIGHTS_CONNECTION_STRING` on the Flightroom installation       | `flightroom` and `flightroom-console` |

---

## Backends

1. In **Resources**, create a resource of type **Application Insights** and paste the connection string of your
   Application Insights resource (Azure portal → your resource → *Overview* → *Connection String*). Give each
   environment its own value if each has its own resource.
2. Attach it to the backends that should report to it, and deploy.

The resource sets one variable, named the way every Azure Monitor SDK reads it by itself, whatever you call the
resource:

```
APPLICATIONINSIGHTS_CONNECTION_STRING
```

On top of that, **every deploy** sets on every container the standard OpenTelemetry variables, attached resource or
not:

| Variable                   | Value                                                       | What it becomes in Application Insights  |
| -------------------------- | ----------------------------------------------------------- | ---------------------------------------- |
| `OTEL_SERVICE_NAME`        | the slug of the application, e.g. `orders-be`                | the cloud role: its node in the Application Map |
| `OTEL_RESOURCE_ATTRIBUTES` | `deployment.environment=<environment slug>,service.version=<deployed version>` | `service.version` is the application version of every item; `deployment.environment` stays among the resource attributes, not on each item |

These names are reserved: a resource cannot set them, and a config map setting them is overridden. Without an SDK in
the container they do nothing at all.

To tell environments apart, give each one its own Application Insights resource: the resource takes a value per
environment.

### In the code

The backend templates of Flightroom already do this. In a backend of your own, turn the SDK on **only when the
variable is set**, so the same image runs with and without it:

**Node.js** — `@azure/monitor-opentelemetry`, in a module loaded before anything else (OpenTelemetry instruments
only the modules loaded after it). In an ES module project preload it with `node --import ./dist/instrumentation.js
dist/index.js`, as the Fastify template does:

```ts
import { useAzureMonitor } from "@azure/monitor-opentelemetry"

if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) useAzureMonitor()
```

**Python** — `azure-monitor-opentelemetry`, before the app is created:

```python
import os
from azure.monitor.opentelemetry import configure_azure_monitor

if os.getenv("APPLICATIONINSIGHTS_CONNECTION_STRING"):
    configure_azure_monitor()
```

**Java** — the [Application Insights Java agent](https://learn.microsoft.com/azure/azure-monitor/app/opentelemetry-enable?tabs=java),
added with `-javaagent` only when the variable is set. No code changes. The agent takes its role name from
`APPLICATIONINSIGHTS_ROLE_NAME` only: the entrypoint of the Java templates copies it from `OTEL_SERVICE_NAME`.

The AI that writes code in Flightroom knows all this: ask it to "send telemetry to Application Insights" on a
backend with the resource attached.

---

## Microfrontends

In the browser the connection string is public by design: it only lets someone *send* telemetry, never read it.
So it is a **global variable**, not a resource:

1. In **Global variables**, add `APPLICATIONINSIGHTS_CONNECTION_STRING` with a value per environment.
2. The host application starts `@microsoft/applicationinsights-web` once, when it finds the variable. The host
   templates of Flightroom do it in `src/telemetry.ts`, and publish the instance as `window.appInsights`: a remote
   calls `window.appInsights?.trackEvent(...)` and never bundles its own SDK. Without the variable the SDK is not
   even downloaded.
3. In `src/telemetry.ts`, rename `ROLE_NAME` after your host: it is its node in the Application Map.

To follow a click in the browser down to the backend and its database, the browser has to send the correlation
headers to the backends, and the backends must accept them:

- add the host of each backend to `CORRELATED_HOSTS` in `src/telemetry.ts` (same origin only, by default);
- a backend on another origin must allow the request headers `traceparent`, `tracestate`, `Request-Id` and
  `Request-Context` in its CORS configuration, and expose `Request-Context`. Add a host to `CORRELATED_HOSTS` only
  once its backend does: otherwise the browser preflight fails, and the call with it.

A backend behind the same domain as the frontend, through its exposure path, needs neither.

---

## The Flightroom console

Set the variable on the installation, in `docker run`, `.env` or the Helm chart (`envSecrets`):

```yaml
APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=...;IngestionEndpoint=https://..."
```

- **Backend:** requests, MongoDB calls, outbound HTTP calls (Git providers, Argo CD, AI providers),
  exceptions and logs, as the cloud role `flightroom` (set `OTEL_SERVICE_NAME` to name it otherwise).
- **Browser:** page views, JavaScript errors and the timings of the API calls, as the cloud role
  `flightroom-console`. The SDK is downloaded only when the variable is set. It uses **no cookies** and is given
  no user identity: no name, email or user id leaves the browser.

`GET /api/configuration` hands the connection string to the browser, as the browser needs it to send anything.

Unset or empty, nothing is loaded and nothing is sent. Sentry (`SENTRY_DSN`) keeps working next to it.
