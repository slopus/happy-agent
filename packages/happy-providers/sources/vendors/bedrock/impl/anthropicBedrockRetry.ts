import { APIConnectionError, APIError, APIUserAbortError } from "@anthropic-ai/sdk/error";

import { isEmptyResponseError } from "@/core/EmptyResponseError.js";
import { isAnthropicRefusalError } from "@/protocol/anthropic/AnthropicRefusalError.js";

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 32_000;

const CONNECTION_FAILURE_CODES = new Set([
    "EAI_AGAIN",
    "ECONNABORTED",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETDOWN",
    "ENETUNREACH",
    "ENOTFOUND",
    "EPIPE",
    "ETIMEDOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
]);

const CONNECTION_FAILURE_MESSAGES = [
    /^terminated$/iu,
    /^fetch failed$/iu,
    /socket hang up/iu,
    /^premature close$/iu,
    /other side closed/iu,
];

/**
 * Anthropic's documented error types and the HTTP statuses they correspond to. A mid-stream SSE
 * `error` event carries one of these types but no HTTP status — the SDK throws it as an APIError
 * with `status` undefined — so retry and classification map the type back onto the status it is
 * documented to be equivalent to.
 */
const ERROR_TYPE_STATUS: Record<string, number> = {
    invalid_request_error: 400,
    authentication_error: 401,
    billing_error: 402,
    permission_error: 403,
    not_found_error: 404,
    rate_limit_error: 429,
    timeout_error: 504,
    api_error: 500,
    overloaded_error: 529,
};

/**
 * AWS Bedrock Runtime's documented exceptions and the HTTP statuses its schema assigns them. A
 * mid-stream failure arrives as an eventstream exception carrying no HTTP status, because the
 * stream itself was an HTTP 200, so retry and classification map the name back onto the status.
 * The SDK's smithy layer throws the members its deserializer models as AWS ServiceExceptions —
 * plain Errors carrying `$fault` and a PascalCase name — and every other member as a bare Error
 * whose name is the camelCase `:exception-type` header and whose message is the raw JSON body.
 */
const BEDROCK_EXCEPTION_STATUS: Record<string, number> = {
    AccessDeniedException: 403,
    ConflictException: 400,
    InternalServerException: 500,
    ModelErrorException: 424,
    ModelNotReadyException: 429,
    ModelTimeoutException: 408,
    ResourceNotFoundException: 404,
    ServiceQuotaExceededException: 400,
    ServiceUnavailableException: 503,
    ThrottlingException: 429,
    ValidationException: 400,
};

/**
 * Every failure spends one of two counters: transient failures — dropped connections, retryable
 * statuses, empty responses — spend the transport budget, and everything else that would end the
 * run — a model refusal, a spent account, a rejected credential — spends the fatal budget, which
 * defaults to zero. Separate counters keep transport noise from starving fatal retries and the
 * other way around, while each budget still bounds the run. Context overflow is the one terminal
 * failure no budget retries, because only a smaller context can fix it and the caller owns that.
 */
export function shouldRetryAnthropicBedrock(
    error: unknown,
    transientFailedAttempts: number,
    maxRetries: number,
    fatalFailedAttempts: number,
    fatalRetries: number,
): boolean {
    if (isAnthropicBedrockAbortError(error)) return false;
    if (isAnthropicBedrockContextOverflow(error)) return false;
    if (isTransientAnthropicBedrockError(error)) return transientFailedAttempts <= maxRetries;
    return fatalFailedAttempts <= fatalRetries;
}

/** Recognizes a failure that waiting can fix, which retries under the transport budget. */
export function isTransientAnthropicBedrockError(error: unknown): boolean {
    if (isEmptyResponseError(error)) return true;
    if (isAnthropicBedrockConnectionFailure(error)) return true;
    return isRetryableAnthropicBedrockStatus(resolveAnthropicBedrockErrorStatus(error));
}

const CONTEXT_OVERFLOW_MESSAGES = [
    "context window",
    "context limit",
    "input is too long",
    "too many input tokens",
] as const;

/** Recognizes the rejection only a smaller context can fix, which no retry budget replays. */
export function isAnthropicBedrockContextOverflow(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return CONTEXT_OVERFLOW_MESSAGES.some((pattern) => message.includes(pattern));
}

function isRetryableAnthropicBedrockStatus(status: number | undefined): boolean {
    return (
        status === 408 ||
        status === 409 ||
        status === 429 ||
        (status !== undefined && status >= 500)
    );
}

/**
 * The error's HTTP status, or the documented equivalent for a mid-stream SSE error event or an
 * AWS Bedrock eventstream exception.
 */
export function resolveAnthropicBedrockErrorStatus(error: unknown): number | undefined {
    if (error instanceof APIError) {
        if (error.status !== undefined) return error.status;
        const details = anthropicBedrockStreamErrorDetails(error);
        return details === undefined ? undefined : ERROR_TYPE_STATUS[details.type];
    }
    return anthropicBedrockRuntimeExceptionDetails(error)?.status;
}

/**
 * Parses an AWS Bedrock Runtime exception thrown out of the eventstream, if that is what it is,
 * resolving the HTTP status AWS's schema assigns its name. Both thrown shapes are recognized: a
 * modeled ServiceException by its `$fault`, and an unmodeled bare Error by its camelCase Bedrock
 * exception name. ModelStreamErrorException relays the upstream model's own failure and carries
 * that status; AWS documents it as retryable, so a missing original status is treated as a
 * server error. An unrecognized name counts as a server error only when smithy itself attributed
 * the fault to the server, evidenced by the `$metadata` every deserialized exception carries.
 */
export function anthropicBedrockRuntimeExceptionDetails(
    error: unknown,
): { name: string; status: number | undefined; message: string | undefined } | undefined {
    if (!(error instanceof Error)) return undefined;
    const record = error as unknown as {
        $fault?: unknown;
        $metadata?: unknown;
        originalStatusCode?: unknown;
    };
    const decorated =
        (record.$fault === "client" || record.$fault === "server") &&
        typeof record.$metadata === "object" &&
        record.$metadata !== null;
    const name = error.name.charAt(0).toUpperCase() + error.name.slice(1);
    const mapped = BEDROCK_EXCEPTION_STATUS[name];
    const known = typeof mapped === "number" || name === "ModelStreamErrorException";
    if (!known && !decorated) return undefined;
    const message = extractBedrockExceptionMessage(error.message);
    if (name === "ModelStreamErrorException") {
        return {
            name,
            status: typeof record.originalStatusCode === "number" ? record.originalStatusCode : 500,
            message,
        };
    }
    if (typeof mapped === "number") return { name, status: mapped, message };
    return { name, status: record.$fault === "server" ? 500 : undefined, message };
}

/** The unmodeled eventstream throw carries the raw JSON body as its message; lift the text out. */
function extractBedrockExceptionMessage(raw: string): string | undefined {
    if (raw.length === 0) return undefined;
    if (!raw.startsWith("{")) return raw;
    try {
        const parsed: unknown = JSON.parse(raw);
        const record =
            typeof parsed === "object" && parsed !== null
                ? (parsed as { message?: unknown; Message?: unknown })
                : undefined;
        if (typeof record?.message === "string") return record.message;
        if (typeof record?.Message === "string") return record.Message;
        return raw;
    } catch {
        return raw;
    }
}

/**
 * Parses the SSE `error` event body out of an APIError the SDK threw mid-stream. Such an error
 * has no HTTP status; its body is `{"type":"error","error":{"type":...,"message":...}}`.
 */
export function anthropicBedrockStreamErrorDetails(
    error: unknown,
): { type: string; message: string | undefined } | undefined {
    if (!(error instanceof APIError) || error.status !== undefined) return undefined;
    if (error instanceof APIConnectionError) return undefined;
    const body: unknown = error.error;
    const inner =
        typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
    const record =
        typeof inner === "object" && inner !== null
            ? (inner as { type?: unknown; message?: unknown })
            : undefined;
    const type = typeof error.type === "string" ? error.type : record?.type;
    if (typeof type !== "string") return undefined;
    return {
        type,
        message: typeof record?.message === "string" ? record.message : undefined,
    };
}

/** Recognizes a dropped or timed-out connection, including undici's raw mid-body stream errors. */
export function isAnthropicBedrockConnectionFailure(error: unknown): boolean {
    if (isAnthropicBedrockAbortError(error)) return false;
    if (error instanceof APIConnectionError) return true;
    if (hasConnectionFailureCode(error)) return true;
    const message = error instanceof Error ? error.message : undefined;
    return (
        message !== undefined &&
        CONNECTION_FAILURE_MESSAGES.some((pattern) => pattern.test(message))
    );
}

function hasConnectionFailureCode(value: unknown): boolean {
    const seen = new Set<object>();
    let current = value;
    while (typeof current === "object" && current !== null && !seen.has(current)) {
        seen.add(current);
        const record = current as { cause?: unknown; code?: unknown };
        if (typeof record.code === "string" && CONNECTION_FAILURE_CODES.has(record.code)) {
            return true;
        }
        current = record.cause;
    }
    return false;
}

/**
 * Recognizes a cancellation even when the caller's signal is not observably aborted, so neither
 * retry budget can replay a request somebody stopped on purpose.
 */
export function isAnthropicBedrockAbortError(value: unknown): boolean {
    const seen = new Set<object>();
    let current = value;
    while (typeof current === "object" && current !== null && !seen.has(current)) {
        if (current instanceof APIUserAbortError) return true;
        seen.add(current);
        const record = current as { cause?: unknown; code?: unknown; name?: unknown };
        if (record.name === "AbortError" || record.code === "ABORT_ERR") return true;
        current = record.cause;
    }
    return false;
}

export function resolveAnthropicBedrockRetryDelay(
    error: unknown,
    failedAttempts: number,
    now: () => number = Date.now,
): number {
    const headers = error instanceof APIError ? error.headers : undefined;
    const retryAfterMilliseconds = headers?.get("retry-after-ms");
    if (retryAfterMilliseconds) {
        const milliseconds = Number.parseFloat(retryAfterMilliseconds);
        if (!Number.isNaN(milliseconds)) return milliseconds;
    }
    const retryAfter = headers?.get("retry-after");
    if (retryAfter) {
        const seconds = Number.parseFloat(retryAfter);
        if (!Number.isNaN(seconds)) return seconds * 1_000;
        return Date.parse(retryAfter) - now();
    }
    const baseDelay = Math.min(BASE_DELAY_MS * 2 ** Math.max(0, failedAttempts - 1), MAX_DELAY_MS);
    return baseDelay + Math.random() * 0.25 * baseDelay;
}

export function waitForAnthropicBedrockRetry(
    milliseconds: number,
    signal?: AbortSignal,
): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(finish, milliseconds);
        signal?.addEventListener("abort", abort, { once: true });

        function abort(): void {
            clearTimeout(timeout);
            reject(signal?.reason);
        }

        function finish(): void {
            signal?.removeEventListener("abort", abort);
            resolve();
        }
    });
}

/** Describes the retry using the allowance of whichever budget the failure spends. */
export function describeAnthropicBedrockRetry(
    error: unknown,
    failedAttempts: number,
    delay: number,
    allowance: number,
): string {
    if (isEmptyResponseError(error)) return error.message;
    if (isAnthropicRefusalError(error)) {
        const refusal =
            error.category === undefined
                ? "model refusal"
                : `model refusal (category: ${error.category})`;
        return `Anthropic Bedrock ${refusal}; retrying in ${formatDelay(delay)}, attempt ${failedAttempts} of ${allowance}.`;
    }
    const status =
        error instanceof APIError && error.status !== undefined
            ? `HTTP ${error.status}`
            : anthropicBedrockStreamErrorDetails(error) !== undefined ||
                anthropicBedrockRuntimeExceptionDetails(error) !== undefined
              ? "error during the response stream"
              : "connection failure";
    return `Anthropic Bedrock ${status}; retrying in ${formatDelay(delay)}, attempt ${failedAttempts} of ${allowance}.`;
}

function formatDelay(milliseconds: number): string {
    if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
    const seconds = milliseconds / 1_000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
}
