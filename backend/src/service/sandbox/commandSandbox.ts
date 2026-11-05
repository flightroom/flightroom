/** What came out of one command: its exit code and the end of what it printed, stdout and stderr in the order written. */
export interface SandboxCommandResult {
    exitCode: number
    output: string
    /** Bytes cut from the start of the output: errors are printed last, the end is what is kept. */
    cutBytes: number
}

export interface SandboxExecOptions {
    /** Absolute folder inside the sandbox. */
    workdir?: string
    environment?: Record<string, string>
    stdin?: Buffer
    timeoutSecs?: number
    signal?: AbortSignal
    /** Told what the command prints as it prints it, stdout and stderr in the order written. It must not throw. */
    onOutput?: (text: string) => void
}

/**
 * An isolated machine the code of a repository can run in: whatever runs there cannot reach the
 * console, its credentials, nor the network beyond what its policy allows.
 */
export interface CommandSandbox {
    /** The folder everything of one conversation lives under: the copies of the repositories, its markers and logs. */
    readonly root: string
    /** The home of the commands, with the caches of the package managers, shared by the conversations of the sandbox; under the root when missing. */
    readonly home?: string
    /**
     * Where the package managers keep what they download, next to the home: a template of the gateway may mount there a
     * volume every sandbox shares. In the home, where each tool puts it, when missing.
     */
    readonly cache?: string
    /** Runs a program, never through a shell unless the command is one. */
    exec(command: string[], options?: SandboxExecOptions): Promise<SandboxCommandResult>
    /** Exposes a loopback HTTP service through the gateway, when the sandbox supports it. */
    exposeService?(targetPort: number, name: string): Promise<string>
}
