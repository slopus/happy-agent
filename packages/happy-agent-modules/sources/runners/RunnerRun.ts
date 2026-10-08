/** One of the product's own programs to run on a runner and wait for. */
export interface RunnerRunOptions {
    readonly command: string;
    readonly args: readonly string[];
    /** Where it starts, in the runner's own paths. Defaults to the runner's home directory. */
    readonly cwd?: string;
    /** Changes to the runner's environment: a string sets a variable and `null` removes it. */
    readonly environment?: Readonly<Record<string, string | null>>;
    /** Output past this many bytes stops the program. */
    readonly maximumBytes: number;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
}

/** One finished program on a runner, with output bounded the way `execFile` bounds it. */
export interface RunnerRunResult {
    readonly code: number;
    readonly stdout: Buffer;
    readonly stderr: string;
    /** Output past the bound was discarded and the program was stopped. */
    readonly truncated: boolean;
    readonly timedOut: boolean;
}
