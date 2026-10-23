import { Schema } from "mongoose"
import { fastify } from ".."
import Frontend, { IFrontend } from "../models/FrontendModel"
import { FrontendCompiler, FrontendFramework, FrontendStackSource, parseCompiler, parseFramework } from "../types/FrontendStack"
import BaseAuthorizedService from "./BaseAuthorizedService"
import RepositoryFileService, { mapWithConcurrency, REPOSITORY_CONCURRENCY, RepositoryTarget, toErrorMessage } from "./RepositoryFileService"

const PACKAGE_JSON_PATH = "package.json"

/**
 * The extra package a bundler needs to do module federation. Webpack ships
 * ModuleFederationPlugin inside `webpack.container`, so there is nothing to add there.
 */
export const FEDERATION_PLUGIN_BY_COMPILER: Partial<Record<FrontendCompiler, string>> = {
    [FrontendCompiler.VITE]: "@originjs/vite-plugin-federation"
}

/** The client package a host imports remoteUrl() from */
export const CLIENT_PACKAGE = "@mfe-orchestrator-hub/client"

/**
 * Config files probed in order, so a repository carrying both a vite and a webpack config is
 * reported as the one its dependencies point at rather than as whichever file was looked at first.
 */
const CONFIG_CANDIDATES: { path: string; compiler: FrontendCompiler }[] = [
    { path: "vite.config.ts", compiler: FrontendCompiler.VITE },
    { path: "vite.config.js", compiler: FrontendCompiler.VITE },
    { path: "vite.config.mjs", compiler: FrontendCompiler.VITE },
    { path: "webpack.config.js", compiler: FrontendCompiler.WEBPACK },
    { path: "webpack.config.ts", compiler: FrontendCompiler.WEBPACK },
    { path: "webpack.config.mjs", compiler: FrontendCompiler.WEBPACK }
]

/** Most specific first: an Angular app also declares rxjs, a Vue one never declares react */
const FRAMEWORK_MARKERS: { dependency: string; framework: FrontendFramework }[] = [
    { dependency: "@angular/core", framework: FrontendFramework.ANGULAR },
    { dependency: "vue", framework: FrontendFramework.VUE },
    { dependency: "react", framework: FrontendFramework.REACT }
]

/**
 * Dependencies that name an integration model rather than a bundler. They win over the bundler:
 * the single-spa and micro-lc templates are built with Vite too, and reading them as VITE would
 * hand out module federation instructions for an app that loads its remotes at runtime.
 */
const INTEGRATION_MARKERS: { dependency: string; compiler: FrontendCompiler }[] = [
    { dependency: "single-spa", compiler: FrontendCompiler.SINGLE_SPA },
    { dependency: "single-spa-react", compiler: FrontendCompiler.SINGLE_SPA },
    { dependency: "@micro-lc/orchestrator", compiler: FrontendCompiler.MICRO_LC },
    { dependency: "@micro-lc/interfaces", compiler: FrontendCompiler.MICRO_LC }
]

/**
 * A micro-lc parcel declares no micro-lc package at all: it is a library build in UMD format,
 * the only one qiankun can evaluate, whose entry is the parcel. Both words in the bundler config
 * are the signal, so an ordinary UMD library is not taken for a parcel.
 */
const isMicrolcParcelConfig = (configContent: string): boolean => /['"]umd['"]/.test(configContent) && /parcel/i.test(configContent)

const COMPILER_MARKERS: { dependency: string; compiler: FrontendCompiler }[] = [
    { dependency: "@originjs/vite-plugin-federation", compiler: FrontendCompiler.VITE },
    { dependency: "vite", compiler: FrontendCompiler.VITE },
    { dependency: "webpack", compiler: FrontendCompiler.WEBPACK }
]

export interface DetectedStack {
    framework?: FrontendFramework
    compiler?: FrontendCompiler
    /** Path of the bundler config found in the repository, when there is one */
    configPath?: string
    /** Whether the bundler config already mentions module federation */
    federationConfigured: boolean
    /** Whether the federation plugin the bundler needs is declared in package.json, or none is */
    federationPluginInstalled: boolean
    /** Whether the client package that resolves remote urls is already declared */
    clientPackageInstalled: boolean
}

export interface FrontendStackDetectionDTO extends Partial<DetectedStack> {
    frontendId: string
    slug: string
    name: string
    branch?: string
    error?: string
}

interface PackageManifest {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
}

/**
 * Works out the framework and bundler of a frontend by reading its repository.
 *
 * Web components are deliberately never inferred: a Vite project without the federation plugin
 * looks exactly like one that has simply not been integrated yet, which is the case this whole
 * feature exists to fix. That stack only comes from a template or from the user.
 *
 * single-spa and micro-lc are inferred, because they leave a clear signal: a dependency on their
 * packages, or for a micro-lc parcel a UMD library build of its parcel entry.
 */
export class StackDetectionService extends BaseAuthorizedService {
    private readonly repositoryFiles = new RepositoryFileService(this.user)

    /**
     * Detects the stack of every frontend of the project backed by a repository and stores
     * what it found, leaving alone the ones whose stack came from a template or from the user.
     */
    async detectForProject(projectId: string | Schema.Types.ObjectId): Promise<FrontendStackDetectionDTO[]> {
        // Stores what it finds on every frontend of the project: those reaching the whole project
        // only. The access to the project itself is checked when the repositories are resolved.
        await this.ensureWholeProject(projectId)
        const targets = await this.repositoryFiles.resolveTargets(projectId)

        return mapWithConcurrency(targets, REPOSITORY_CONCURRENCY, async target => {
            const base = {
                frontendId: target.frontend._id.toString(),
                slug: target.frontend.slug,
                name: target.frontend.name
            }

            if (!target.codeRepository) {
                return { ...base, error: "Code repository connection not found" }
            }

            try {
                const branch = await this.repositoryFiles.getDefaultBranch(target)
                const detected = await this.detect(target, branch)
                await this.persist(target.frontend, detected)

                return { ...base, branch, ...detected }
            } catch (error) {
                fastify.log.error(error, `Unable to detect the stack of ${target.frontend.slug}`)
                return { ...base, error: toErrorMessage(error) }
            }
        })
    }

    /** Reads package.json and the bundler config of one repository on `branch`. */
    async detect(target: RepositoryTarget, branch: string): Promise<DetectedStack> {
        const manifestFile = await this.repositoryFiles.readFile(target, PACKAGE_JSON_PATH, branch)
        const manifest = manifestFile ? this.parseManifest(manifestFile.raw) : undefined
        const declared = manifest ? this.declaredDependencies(manifest) : new Set<string>()

        const framework = FRAMEWORK_MARKERS.find(marker => declared.has(marker.dependency))?.framework
        const compilerFromManifest = COMPILER_MARKERS.find(marker => declared.has(marker.dependency))?.compiler

        const config = await this.findConfig(target, branch, compilerFromManifest)
        const integration = INTEGRATION_MARKERS.find(marker => declared.has(marker.dependency))?.compiler || (config && isMicrolcParcelConfig(config.raw) ? FrontendCompiler.MICRO_LC : undefined)
        const compiler = integration || compilerFromManifest || config?.compiler

        return {
            framework,
            compiler,
            configPath: config?.path,
            federationConfigured: Boolean(config && this.mentionsFederation(config.raw)),
            federationPluginInstalled: this.isFederationPluginInstalled(compiler, declared),
            clientPackageInstalled: declared.has(CLIENT_PACKAGE)
        }
    }

    /**
     * The bundler config of the repository. When package.json already says which bundler is in
     * use, only that bundler's candidates are read, which also keeps the number of API calls down.
     */
    private async findConfig(target: RepositoryTarget, branch: string, compiler?: FrontendCompiler): Promise<{ path: string; compiler: FrontendCompiler; raw: string } | null> {
        const candidates = compiler ? CONFIG_CANDIDATES.filter(candidate => candidate.compiler === compiler) : CONFIG_CANDIDATES

        for (const candidate of candidates) {
            const file = await this.repositoryFiles.readFile(target, candidate.path, branch)
            if (file) {
                return { path: candidate.path, compiler: candidate.compiler, raw: file.raw }
            }
        }

        return null
    }

    private isFederationPluginInstalled(compiler: FrontendCompiler | undefined, declared: Set<string>): boolean {
        if (!compiler) {
            return false
        }

        const plugin = FEDERATION_PLUGIN_BY_COMPILER[compiler]
        return plugin ? declared.has(plugin) : true
    }

    private mentionsFederation(configContent: string): boolean {
        return configContent.includes("federation(") || configContent.includes("ModuleFederationPlugin")
    }

    private declaredDependencies(manifest: PackageManifest): Set<string> {
        return new Set([manifest.dependencies, manifest.devDependencies, manifest.peerDependencies, manifest.optionalDependencies].flatMap(section => (section ? Object.keys(section) : [])))
    }

    private parseManifest(raw: string): PackageManifest | undefined {
        try {
            return JSON.parse(raw) as PackageManifest
        } catch {
            // A package.json we cannot parse tells us nothing about the stack, and failing the
            // whole detection over it would hide the repositories that are fine
            return undefined
        }
    }

    /**
     * Stores a detected stack, unless the frontend already carries one that did not come
     * from detection: a template declared it, or the user picked it by hand.
     */
    private async persist(frontend: IFrontend, detected: DetectedStack): Promise<void> {
        if (!detected.framework && !detected.compiler) {
            return
        }

        if (frontend.stack && frontend.stack.source !== FrontendStackSource.DETECTED) {
            return
        }

        await Frontend.updateOne(
            { _id: frontend._id },
            {
                $set: {
                    stack: {
                        framework: detected.framework,
                        compiler: detected.compiler,
                        source: FrontendStackSource.DETECTED,
                        detectedAt: new Date()
                    }
                }
            }
        )
    }

    /** Records a stack the user chose, which detection then stops overwriting. */
    async setManualStack(frontendId: string, framework?: string, compiler?: string): Promise<IFrontend | null> {
        const frontend = await Frontend.findById(frontendId)

        if (!frontend) {
            return null
        }

        await this.ensureAccessToFrontend(frontend)

        frontend.stack = {
            framework: parseFramework(framework),
            compiler: parseCompiler(compiler),
            source: FrontendStackSource.MANUAL
        }

        return frontend.save()
    }
}

export default StackDetectionService
