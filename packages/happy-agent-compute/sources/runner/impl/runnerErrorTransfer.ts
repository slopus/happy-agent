import type { RunnerError } from "../runnerProtocol.js";

const MAX_MESSAGE_LENGTH = 16_384;

/**
 * Describe a failure on the runner so the daemon can rebuild it.
 *
 * Callers above compute branch on Node-style codes such as `ENOENT` and `EEXIST`, so those fields
 * cross the protocol intact. Stacks do not: they describe the runner's code, not the caller's.
 */
export function runnerErrorFromException(error: unknown): RunnerError {
    if (!(error instanceof Error)) {
        return { name: "Error", message: truncate(String(error)) };
    }
    const details = error as NodeJS.ErrnoException;
    return {
        name: truncate(error.name, 256),
        message: truncate(error.message),
        ...(typeof details.code === "string" ? { code: truncate(details.code, 128) } : {}),
        ...(typeof details.errno === "number" && Number.isInteger(details.errno)
            ? { errno: details.errno }
            : {}),
        ...(typeof details.syscall === "string" ? { syscall: truncate(details.syscall, 128) } : {}),
        ...(typeof details.path === "string" ? { path: truncate(details.path, 4096) } : {}),
    };
}

/** Rebuild a runner's failure as an `Error` carrying the same name, message, and code. */
export function runnerErrorToException(error: RunnerError): Error {
    const rebuilt = new Error(error.message) as NodeJS.ErrnoException;
    rebuilt.name = error.name;
    if (error.code !== undefined) rebuilt.code = error.code;
    if (error.errno !== undefined) rebuilt.errno = error.errno;
    if (error.syscall !== undefined) rebuilt.syscall = error.syscall;
    if (error.path !== undefined) rebuilt.path = error.path;
    return rebuilt;
}

function truncate(value: string, limit = MAX_MESSAGE_LENGTH): string {
    return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
