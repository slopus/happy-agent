/**
 * A daemon-lifecycle failure the person running the CLI can act on, such as a daemon that will
 * not stop or a version mismatch that needs a restart. Callers may present the message with the
 * optional next step instead of a stack trace.
 */
export class AgentDaemonError extends Error {
    readonly hint: string | undefined;
    readonly exitCode: number;

    constructor(
        message: string,
        options: { cause?: unknown; hint?: string; exitCode?: number } = {},
    ) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = "AgentDaemonError";
        this.hint = options.hint;
        this.exitCode = options.exitCode ?? 1;
    }
}
