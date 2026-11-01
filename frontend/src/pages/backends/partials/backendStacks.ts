import { type SimpleIcon, siDjango, siDotnet, siExpress, siFastapi, siFastify, siFlask, siGin, siGo, siNestjs, siNodedotjs, siOpenjdk, siPython, siQuarkus, siSpringboot } from "simple-icons"
import { type Backend, BackendRuntime } from "@/hooks/apiClients/useBackendsApi"

/** A choice of the Technology field of a backend: a language, or a framework that brings its language with it */
export interface BackendStackChoice {
    value: string
    runtime: BackendRuntime
    framework?: string
    icon?: SimpleIcon
}

const language = (runtime: BackendRuntime, icon: SimpleIcon): BackendStackChoice => ({ value: runtime, runtime, icon })

const framework = (name: string, runtime: BackendRuntime, icon?: SimpleIcon): BackendStackChoice => ({ value: name, runtime, framework: name, icon })

/** Each language followed by its frameworks: the frameworks spelled as the templates spell them, which the live previews read */
export const BACKEND_STACK_CHOICES: BackendStackChoice[] = [
    language(BackendRuntime.NODE, siNodedotjs),
    framework("Express", BackendRuntime.NODE, siExpress),
    framework("NestJS", BackendRuntime.NODE, siNestjs),
    framework("Fastify", BackendRuntime.NODE, siFastify),
    language(BackendRuntime.PYTHON, siPython),
    framework("FastAPI", BackendRuntime.PYTHON, siFastapi),
    framework("Flask", BackendRuntime.PYTHON, siFlask),
    framework("Django", BackendRuntime.PYTHON, siDjango),
    language(BackendRuntime.JAVA, siOpenjdk),
    framework("Spring Boot", BackendRuntime.JAVA, siSpringboot),
    framework("Quarkus", BackendRuntime.JAVA, siQuarkus),
    framework("Micronaut", BackendRuntime.JAVA),
    language(BackendRuntime.GO, siGo),
    framework("Gin", BackendRuntime.GO, siGin),
    language(BackendRuntime.DOTNET, siDotnet),
    framework("ASP.NET Core", BackendRuntime.DOTNET, siDotnet)
]

/** The choice a stack is: its framework when it is one of the list, else its language; none when neither is known */
export const stackChoiceOf = (stack?: Backend["stack"]): BackendStackChoice | undefined => {
    const name = stack?.framework?.trim().toLowerCase()
    return BACKEND_STACK_CHOICES.find(choice => name && choice.framework?.toLowerCase() === name) ?? BACKEND_STACK_CHOICES.find(choice => !choice.framework && choice.runtime === stack?.runtime)
}
