import { BackendRuntime } from "@/hooks/apiClients/useBackendsApi"

export const RUNTIME_LABEL_KEYS: Record<BackendRuntime, string> = {
    [BackendRuntime.NODE]: "backends.runtime.NODE",
    [BackendRuntime.PYTHON]: "backends.runtime.PYTHON",
    [BackendRuntime.GO]: "backends.runtime.GO",
    [BackendRuntime.DOTNET]: "backends.runtime.DOTNET",
    [BackendRuntime.JAVA]: "backends.runtime.JAVA",
    [BackendRuntime.OTHER]: "backends.runtime.OTHER"
}
