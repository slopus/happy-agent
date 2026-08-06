import { extractProviderErrorDiagnostics } from "@/core/extractProviderErrorDiagnostics.js";
import type { SessionCacheUsage } from "@/core/SessionCacheUsage.js";
import type { SessionEvent } from "@/core/SessionEvent.js";

type ErrorDoneEvent = Extract<SessionEvent, { type: "done"; state: "error" }>;

export class EmptyResponseError extends Error {
    readonly code = "empty_response";
    readonly errorType = "empty_response";
    readonly usage: SessionCacheUsage | undefined;

    constructor(provider: string, usage?: SessionCacheUsage) {
        super(`${provider} returned a response with zero output tokens.`);
        this.name = "EmptyResponseError";
        this.usage = usage;
    }
}

export function isEmptyResponseError(error: unknown): error is EmptyResponseError {
    return error instanceof EmptyResponseError;
}

export function emptyResponseDoneEvent(
    error: EmptyResponseError,
    attempts: number,
): ErrorDoneEvent {
    const diagnostics = extractProviderErrorDiagnostics(error, {
        attempts: Math.max(1, attempts),
        upstreamMessage: error.message,
    });
    return {
        type: "done",
        state: "error",
        kind: "internal_error",
        message: error.message,
        providerError: {
            type: "empty_response",
            ...(diagnostics === undefined ? {} : { diagnostics }),
        },
    };
}
