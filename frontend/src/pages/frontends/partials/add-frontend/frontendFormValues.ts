import type { DefaultValues } from "react-hook-form"
import type { ICodeRepository } from "@/hooks/apiClients/useCodeRepositoriesApi"
import { CanaryDeploymentType, CanaryType, type Frontend, FrontendKind } from "@/hooks/apiClients/useFrontendsApi"
import type { Storage } from "@/hooks/apiClients/useStorageApi"
import type { VariableMap } from "@/hooks/apiClients/useVariableMapsApi"
import { resourceFormValues } from "@/pages/backends/partials/containerResources"
import { environmentVersionFormValues } from "@/pages/backends/partials/environmentVersions"
import { designSystemFormValues, toDesignSystem } from "@/pages/settings/partials/DesignSystemFields"
import type { FormInput, FormValues } from "./frontendFormSchema"

const getStandardHost = (storages: Storage[]): FormInput["host"] => {
    const standardHost: FormInput["host"] = {
        type: "MFE_ORCHESTRATOR_HUB",
        entryPoint: "assets/remoteEntry.js"
    }
    if (!storages || storages.length == 0) return standardHost

    const storageId = storages.find(storage => storage.default)?._id
    if (!storageId) return standardHost

    return {
        type: "CUSTOM_SOURCE",
        storageId,
        entryPoint: "assets/remoteEntry.js"
    }
}

interface DefaultsInput {
    frontend?: Frontend
    storages: Storage[]
    repositories: ICodeRepository[]
    configMaps: VariableMap[]
    secrets: VariableMap[]
    initialDomainId: string | null
    template: string | null
}

/** What the form starts with: the saved frontend, or a new BUNDLE */
export const frontendFormDefaults = ({ frontend, storages, repositories, configMaps, secrets, initialDomainId, template }: DefaultsInput): DefaultValues<FormInput> => {
    // The backend defaults until it declares its own: a BUNDLE holds them only in case it is switched to DOCKER
    const containerDefaults = {
        port: String(frontend?.port ?? 8080),
        livenessPath: frontend?.livenessPath ?? "/health/live",
        readinessPath: frontend?.readinessPath ?? "/health/ready",
        docsPath: frontend?.docsPath ?? "",
        openApiPath: frontend?.openApiPath ?? "",
        // A DOCKER is usually the shell, which browsers reach: exposed until said otherwise, both a new one and a BUNDLE
        // being made one. A DOCKER saved without a path was left unexposed on purpose, and stays so
        exposed: frontend?.exposurePath ? true : !frontend || frontend.kind !== FrontendKind.DOCKER,
        exposurePath: frontend?.exposurePath ?? "",
        ...resourceFormValues(frontend),
        environmentVersions: environmentVersionFormValues(frontend),
        image: { repository: frontend?.image?.repository ?? "" },
        env: frontend?.env ?? [],
        // Only the maps that still exist: one deleted meanwhile has no checkbox to untick, and would make every save fail
        configMapIds: (frontend?.configMapIds ?? []).filter(id => configMaps.some(map => map._id === id)),
        secretIds: (frontend?.secretIds ?? []).filter(id => secrets.some(map => map._id === id))
    }

    // A DOCKER may be saved without a host: the hosting tab it would be validated in is hidden for it
    return frontend
        ? {
              ...frontend,
              kind: frontend.kind ?? FrontendKind.BUNDLE,
              version: frontend.version ?? "",
              host: frontend.host ?? getStandardHost(storages),
              designSystemOverride: Boolean(frontend.designSystem?.packageName),
              designSystem: designSystemFormValues(frontend.designSystem),
              ...containerDefaults
          }
        : {
              slug: "",
              name: "",
              description: "",
              domainId: initialDomainId ?? "",
              context: "",
              designSystemOverride: false,
              designSystem: designSystemFormValues(),
              kind: FrontendKind.BUNDLE,
              version: "1.0.0",
              host: getStandardHost(storages),
              ...containerDefaults,
              ...(repositories && repositories.length > 0
                  ? {
                        codeRepository: {
                            enabled: Boolean(template),
                            repositoryId: "create_new",
                            codeRepositoryId: repositories.length === 1 ? repositories[0]._id : repositories.find(repo => repo.default)?._id
                        }
                    }
                  : {
                        codeRepository: {
                            enabled: false
                        }
                    }),
              canary: {
                  enabled: false,
                  percentage: 0,
                  type: CanaryType.ON_SESSION,
                  deploymentType: CanaryDeploymentType.BASED_ON_VERSION
              }
          }
}

interface PayloadOptions {
    isEdit: boolean
    template: string | null
    /** Read only when it matters, as the submit always did: reading the dirty fields subscribes the form to them */
    isVersionDirty: () => boolean
}

/** What the API receives for the values of the form */
export const toFrontendPayload = (data: FormValues, { isEdit, template, isVersionDirty }: PayloadOptions) => {
    const {
        port,
        livenessPath,
        readinessPath,
        docsPath,
        openApiPath,
        cpuRequest,
        cpuLimit,
        memoryRequest,
        memoryLimit,
        environmentResources,
        environmentVersions,
        exposed,
        exposurePath,
        image,
        env,
        configMapIds,
        secretIds,
        designSystemOverride,
        designSystem,
        ...rest
    } = data
    const dataToSend = {
        ...rest,
        // Null: it builds with the design system of the project, else the organization's
        designSystem: designSystemOverride ? toDesignSystem(designSystem) : null,
        version: data.version === "custom" ? data.customVersion : data.version,
        // Blank: the frontend is in no domain
        domainId: data.domainId || null,
        // Only a DOCKER declares a container, and Flightroom runs no canary for it
        ...(data.kind === FrontendKind.DOCKER
            ? {
                  port: Number(port),
                  livenessPath: livenessPath?.trim(),
                  readinessPath: readinessPath?.trim(),
                  docsPath: docsPath?.trim(),
                  openApiPath: openApiPath?.trim(),
                  // Empty: the default of the chart
                  cpuRequest: cpuRequest?.trim(),
                  cpuLimit: cpuLimit?.trim(),
                  memoryRequest: memoryRequest?.trim(),
                  memoryLimit: memoryLimit?.trim(),
                  // Empty: the container's, as above
                  environmentResources,
                  // Blank: the version above
                  environmentVersions: environmentVersions?.map(entry => ({ ...entry, version: entry.version.trim() })),
                  // Null: not exposed on the host of the environments
                  exposurePath: exposed ? exposurePath?.trim() : null,
                  image,
                  env,
                  configMapIds,
                  secretIds,
                  canary: data.canary && { ...data.canary, enabled: false }
              }
            : {})
    } as Frontend & { customVersion?: string }

    delete dataToSend.customVersion
    // A DOCKER frontend's version is the tag of its image: sent only when typed here, so that saving the form
    // does not move back a newer one its pipeline registered meanwhile
    if (data.kind === FrontendKind.DOCKER && (!dataToSend.version?.trim() || (isEdit && !isVersionDirty()))) delete dataToSend.version

    if (template) {
        if (!dataToSend.codeRepository?.createData) {
            dataToSend.codeRepository.createData = {}
        }
        dataToSend.codeRepository.createData.template = template
        if (!dataToSend.codeRepository.createData.name) {
            dataToSend.codeRepository.createData.name = data.slug
        }
    }
    return dataToSend
}
