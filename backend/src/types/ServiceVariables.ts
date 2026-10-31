/**
 * The OpenTelemetry variables every deploy hands to the containers of an application: who the service is, in which
 * environment and at which version. Every OpenTelemetry SDK reads them by itself, Azure Monitor's included, which
 * makes the service name the cloud role of Application Insights: one node per application in its Application Map.
 */

export const OTEL_SERVICE_NAME_VARIABLE = "OTEL_SERVICE_NAME"
export const OTEL_RESOURCE_ATTRIBUTES_VARIABLE = "OTEL_RESOURCE_ATTRIBUTES"

/** Set by every deploy on every container: a resource setting one of them too would be there twice */
export const SERVICE_VARIABLES = [OTEL_SERVICE_NAME_VARIABLE, OTEL_RESOURCE_ATTRIBUTES_VARIABLE]

/** The values of OTEL_RESOURCE_ATTRIBUTES are percent-encoded: a comma or an equals sign would split the list */
const attribute = (key: string, value: string) => `${key}=${encodeURIComponent(value)}`

/** The variables of an application deployed at `version` in an environment */
export const serviceVariables = (application: { slug: string }, environment: { slug: string }, version: string): Array<{ name: string; value: string }> => [
    { name: OTEL_SERVICE_NAME_VARIABLE, value: application.slug },
    { name: OTEL_RESOURCE_ATTRIBUTES_VARIABLE, value: [attribute("deployment.environment", environment.slug), attribute("service.version", version)].join(",") }
]
