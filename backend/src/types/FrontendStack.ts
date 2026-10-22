/**
 * The stack a frontend is built with, the two axes the integration instructions depend on.
 *
 * They mirror what the marketplace templates declare (`framework` and `compiler`), because a
 * frontend created from a template already knows its stack and should never be asked again.
 */

export enum FrontendFramework {
    REACT = "REACT",
    VUE = "VUE",
    ANGULAR = "ANGULAR"
}

export enum FrontendCompiler {
    VITE = "VITE",
    WEBPACK = "WEBPACK",
    /**
     * Not a bundler: web component frontends are plain scripts registering a custom element,
     * so they are integrated at runtime by the host instead of through module federation.
     */
    WEBCOMPONENT = "WEBCOMPONENT",
    /**
     * Not a bundler either, an integration model: a single-spa root config registers applications
     * that are native ES modules exporting lifecycles, imports them at runtime from `remoteUrl()`
     * and shares React through an import map. The templates build with Vite, but no module
     * federation is involved.
     */
    SINGLE_SPA = "SINGLE_SPA",
    /**
     * An integration model too: a micro-lc shell mounts parcels, UMD scripts exporting lifecycles,
     * from a configuration built at runtime with `remoteUrl()`, and shares React through
     * `window.React`, `window.ReactDOM` and `window.ReactJSXRuntime`. Built with Vite, never federated.
     */
    MICRO_LC = "MICRO_LC"
}

export enum FrontendStackSource {
    /** Declared by the marketplace template the repository was created from */
    TEMPLATE = "TEMPLATE",
    /** Read out of the repository */
    DETECTED = "DETECTED",
    /** Chosen by the user, and never overwritten by detection */
    MANUAL = "MANUAL"
}

export interface FrontendStackDTO {
    framework?: FrontendFramework
    compiler?: FrontendCompiler
    source: FrontendStackSource
    detectedAt?: Date
}

const FRAMEWORK_BY_NAME: Record<string, FrontendFramework> = {
    react: FrontendFramework.REACT,
    vue: FrontendFramework.VUE,
    angular: FrontendFramework.ANGULAR
}

/** Keyed by the normalised spelling: lowercase, without dashes, underscores or spaces */
const COMPILER_BY_NAME: Record<string, FrontendCompiler> = {
    vite: FrontendCompiler.VITE,
    webpack: FrontendCompiler.WEBPACK,
    webcomponent: FrontendCompiler.WEBCOMPONENT,
    webcomponents: FrontendCompiler.WEBCOMPONENT,
    singlespa: FrontendCompiler.SINGLE_SPA,
    microlc: FrontendCompiler.MICRO_LC
}

/**
 * The marketplace catalogue is fetched from a repository outside this codebase and spells its
 * values freely ("React", "vite", "webcomponent"), so both axes are normalised on the way in and
 * an unknown value becomes undefined rather than a wrong stack.
 */
export const parseFramework = (value?: string): FrontendFramework | undefined => (value ? FRAMEWORK_BY_NAME[value.trim().toLowerCase()] : undefined)

const compilerKey = (value: string): string =>
    value
        .trim()
        .toLowerCase()
        .replace(/[-_\s]/g, "")

export const parseCompiler = (value?: string): FrontendCompiler | undefined => (value ? COMPILER_BY_NAME[compilerKey(value)] : undefined)

/** Module federation only applies to real bundlers: web components, single-spa and micro-lc are wired up at runtime. */
export const supportsModuleFederation = (compiler?: FrontendCompiler): boolean => compiler === FrontendCompiler.VITE || compiler === FrontendCompiler.WEBPACK

/**
 * Integration models whose host is wired up by a file the console generates (the single-spa
 * applications, the micro-lc configuration) rather than by a bundler config.
 */
export const isIntegrationModel = (compiler?: FrontendCompiler): boolean => compiler === FrontendCompiler.SINGLE_SPA || compiler === FrontendCompiler.MICRO_LC
