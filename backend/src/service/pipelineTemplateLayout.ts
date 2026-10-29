import path from "path"
import { IMarket } from "../models/MarketModel"
import { BackendRuntime, isBackendTemplateType } from "../types/BackendStack"

/** The folder of each provider in a pipeline templates repository */
export type PipelineProvider = "github" | "gitlab" | "azure_dev_ops"

/** The pipeline file a provider reads at the root of the repository; GitHub reads the whole `.github` folder instead */
export const ROOT_PIPELINE_FILES: Record<Exclude<PipelineProvider, "github">, string> = { gitlab: ".gitlab-ci.yml", azure_dev_ops: "azure-pipelines.yml" }

/** The language folder of a backend runtime in a pipeline templates repository; none for one the console cannot name */
export const LANGUAGE_FOLDERS: Record<BackendRuntime, string | undefined> = {
    [BackendRuntime.NODE]: "javascript",
    [BackendRuntime.PYTHON]: "python",
    [BackendRuntime.JAVA]: "java",
    [BackendRuntime.GO]: "go",
    [BackendRuntime.DOTNET]: "dotnet",
    [BackendRuntime.OTHER]: undefined
}

/** One folder name, neither `.` nor `..`: what a template's type, compiler and slug must be to be looked up as folders */
export const isFolderName = (name: string | undefined): name is string => !!name && name !== "." && name !== ".." && !name.includes("\\") && path.basename(name) === name

/**
 * The folders a scaffold of `templates` can find a pipeline in, slugs aside: every `<type>/<compiler>`, plus
 * `<type>/<language>` for every language a backend can be written in, and `javascript` for the frontends.
 */
export const pipelineTemplateFolders = (templates: Pick<IMarket, "type" | "compiler">[]): string[] => {
    const folders = new Set<string>()
    for (const { type, compiler } of templates) {
        if (!isFolderName(type)) continue
        if (isFolderName(compiler)) folders.add(`${type}/${compiler}`)
        const languages = isBackendTemplateType(type) ? Object.values(LANGUAGE_FOLDERS) : type === "host" || type === "remote" ? ["javascript"] : []
        for (const language of languages) if (language) folders.add(`${type}/${language}`)
    }
    return [...folders].sort()
}

/**
 * What the console writes in each folder when it initializes a pipeline templates repository, and what tells a
 * folder already has a pipeline: on GitHub any workflow, so that a second one never runs next to it.
 */
export const EMPTY_PIPELINES: Record<PipelineProvider, { file: string; existing: string }> = {
    github: { file: ".github/workflows/build.yml", existing: ".github/workflows" },
    gitlab: { file: ROOT_PIPELINE_FILES.gitlab, existing: ROOT_PIPELINE_FILES.gitlab },
    azure_dev_ops: { file: ROOT_PIPELINE_FILES.azure_dev_ops, existing: ROOT_PIPELINE_FILES.azure_dev_ops }
}
