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
}

/**
 * An isolated machine the code of a repository can run in: whatever runs there cannot reach the
 * console, its credentials, nor the network beyond what its policy allows.
 */
export interface CommandSandbox {
    /** The folder everything lives under: the copies of the repositories, the home of the commands. */
    readonly root: string
    /** Runs a program, never through a shell unless the command is one. */
    exec(command: string[], options?: SandboxExecOptions): Promise<SandboxCommandResult>
    /** Exposes a loopback HTTP service through the gateway, when the sandbox supports it. */
    exposeService?(targetPort: number, name: string): Promise<string>
}
