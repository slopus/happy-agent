/**
 * A failure the person running Happy Terminal can act on, such as a missing session or an unknown flag.
 * These are reported as a short explanation with an optional next step, never as a stack trace.
 */
export class HappyTerminalUserError extends Error {
    readonly hint: string | undefined;

    constructor(message: string, options: { cause?: unknown; hint?: string } = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = "HappyTerminalUserError";
        this.hint = options.hint;
    }
}

export function isHappyTerminalUserError(error: unknown): error is HappyTerminalUserError {
    return error instanceof HappyTerminalUserError;
}
