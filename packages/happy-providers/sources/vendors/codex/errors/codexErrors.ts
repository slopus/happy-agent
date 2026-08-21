import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    extractProviderErrorDiagnostics,
    extractProviderRetryResetAt,
} from "@/core/extractProviderErrorDiagnostics.js";
import { isEmptyResponseError } from "@/core/EmptyResponseError.js";
import type { SessionErrorKind, SessionProviderError } from "@/core/SessionEvent.js";

/**
 * Recognition of the Codex rejections that change what the session does next.
 *
 * Each predicate answers one question the session asks about a failure: whether to surface it,
 * shrink the request, replay the context, refresh the credential, fall back off WebSocket, or
 * resend it unchanged.
 */

export function classifyCodexError(message: string): SessionErrorKind {
    if (/context|prompt.+too long|maximum context|token limit/iu.test(message))
        return "context_overflow";
    if (/billing|credit|quota|usage limit|insufficient_quota/iu.test(message))
        return "billing_error";
    if (/\b(?:internal(?:_| server )error|server_error)\b/iu.test(message)) return "internal_error";
    const handshakeStatus = readCodexWebSocketHandshakeStatus(message);
    if (handshakeStatus !== undefined && handshakeStatus >= 500) return "internal_error";
    if (
        /status 5\d\d|fetch failed|socket|websocket|timed? ?out|service unavailable/iu.test(message)
    )
        return "internal_error";
    return "unknown";
}

export function classifyCodexProviderError(
    error: unknown,
    message: string,
    attempts: number,
): SessionProviderError {
    const diagnostics = extractProviderErrorDiagnostics(error, {
        attempts,
        upstreamMessage: message,
    });
    const usage = readCodexUsageExhaustion(error);
    if (usage !== undefined) {
        const resetAt = usage.resetAt ?? extractProviderRetryResetAt(error);
        return {
            type: "out_of_tokens",
            ...(resetAt === undefined ? {} : { resetAt }),
            ...(diagnostics === undefined ? {} : { diagnostics }),
        };
    }
    const status = diagnostics?.status;
    const normalized = message.toLowerCase();
    const kind = classifyCodexError(message);
    const type: SessionProviderError["type"] =
        isCodexUnauthorizedError(error) || status === 403
            ? "authentication"
            : status === 402 || kind === "billing_error"
              ? "out_of_tokens"
              : status === 429
                ? "rate_limit"
                : status === 503 || normalized.includes("overloaded")
                  ? "server_overloaded"
                  : (status !== undefined && status >= 500) || kind === "internal_error"
                    ? "internal_server_error"
                    : "unclassified";
    if (type === "rate_limit" || type === "out_of_tokens") {
        const resetAt = extractProviderRetryResetAt(error);
        return {
            type,
            ...(resetAt === undefined ? {} : { resetAt }),
            ...(diagnostics === undefined ? {} : { diagnostics }),
        };
    }
    return {
        type,
        ...(diagnostics === undefined ? {} : { diagnostics }),
    };
}

/**
 * The two 429 bodies that mean the account itself is spent rather than momentarily busy.
 *
 * Codex answers an exhausted plan with `usage_limit_reached` and a plan that never included Codex
 * with `usage_not_included`. Both are terminal upstream — vanilla sets `retry_429: false` and turns
 * these bodies straight into `UsageLimitReached` and `UsageNotIncluded` — so recognizing them by
 * body is what separates a spent account from an ordinary throttle that shares the same status.
 */
const codexUsageErrorSchema = Type.Object(
    {
        type: Type.Union([Type.Literal("usage_limit_reached"), Type.Literal("usage_not_included")]),
    },
    { additionalProperties: true },
);

/**
 * Read separately so an unexpected value in either field costs only that field. The plan and the
 * reset time are what make the sentence useful, but neither decides whether the account is spent.
 */
const codexUsagePlanSchema = Type.Object(
    { plan_type: Type.String({ minLength: 1 }) },
    { additionalProperties: true },
);

const codexUsageResetSchema = Type.Object(
    { resets_at: Type.Integer({ minimum: 1 }) },
    { additionalProperties: true },
);

export interface CodexUsageExhaustion {
    kind: "usage_limit_reached" | "usage_not_included";
    planType?: string;
    /** Absolute reset time in epoch milliseconds. */
    resetAt?: number;
}

const USAGE_NESTING_KEYS = ["error", "cause", "body", "response"] as const;
const USAGE_TRAVERSAL_LIMIT = 24;
const CODEX_PRIMARY_RESET_HEADER = "x-codex-primary-reset-at";

/**
 * Finds the usage body wherever the transport buried it.
 *
 * SSE surfaces it as the OpenAI SDK's `APIError`, which copies the body's `type` onto itself and
 * keeps the full body on `error`. WebSocket wraps a server event whose own `type` is `"error"` and
 * whose nested `error` carries the usage body. Both matches are collected so the plan and reset
 * time are read from whichever level actually carried them.
 */
export function readCodexUsageExhaustion(error: unknown): CodexUsageExhaustion | undefined {
    const matches: Record<string, unknown>[] = [];
    const pending: unknown[] = [error];
    const seen = new Set<object>();
    while (pending.length > 0 && seen.size < USAGE_TRAVERSAL_LIMIT) {
        const candidate = pending.shift();
        if (typeof candidate !== "object" || candidate === null || seen.has(candidate)) continue;
        seen.add(candidate);
        const record = candidate as Record<string, unknown>;
        for (const key of USAGE_NESTING_KEYS) {
            if (key in record) pending.push(record[key]);
        }
        if (Value.Check(codexUsageErrorSchema, record)) matches.push(record);
    }
    const first = matches[0];
    if (first === undefined) return undefined;
    const planType = matches.find((match) => Value.Check(codexUsagePlanSchema, match))?.plan_type;
    const resetSeconds = matches.find((match) =>
        Value.Check(codexUsageResetSchema, match),
    )?.resets_at;
    const headerSeconds = Number(readCodexErrorHeader(error, CODEX_PRIMARY_RESET_HEADER));
    const seconds =
        typeof resetSeconds === "number"
            ? resetSeconds
            : Number.isSafeInteger(headerSeconds) && headerSeconds > 0
              ? headerSeconds
              : undefined;
    return {
        kind: first.type as CodexUsageExhaustion["kind"],
        ...(typeof planType === "string" ? { planType } : {}),
        ...(seconds === undefined ? {} : { resetAt: seconds * 1_000 }),
    };
}

const CODEX_PLAN_NAMES = new Map([
    ["business", "Business"],
    ["edu", "Edu"],
    ["ent26", "Enterprise"],
    ["enterprise", "Enterprise"],
    ["enterprise_cbp_automation", "Enterprise Automation"],
    ["enterprise_cbp_usage_based", "Enterprise Usage Based"],
    ["free", "Free"],
    ["go", "Go"],
    ["plus", "Plus"],
    ["pro", "Pro"],
    ["prolite", "Pro Lite"],
    ["self_serve_business_prolite", "Business Pro Lite"],
    ["self_serve_business_usage_based", "Business Usage Based"],
    ["team", "Team"],
]);

const CODEX_USAGE_NOT_INCLUDED_MESSAGE =
    "Codex is not included in this ChatGPT plan. Upgrade to Plus to keep using it: " +
    "https://chatgpt.com/explore/plus.";

/**
 * Says which account ran out and when it comes back, the way the native client does.
 *
 * A spent account is the one failure a person can actually act on, so the sentence names the plan
 * and the reset time instead of reporting a status code.
 */
export function codexUsageExhaustionMessage(
    usage: CodexUsageExhaustion,
    now: number = Date.now(),
): string {
    if (usage.kind === "usage_not_included") return CODEX_USAGE_NOT_INCLUDED_MESSAGE;
    const plan = usage.planType === undefined ? undefined : describeCodexPlan(usage.planType);
    const subject =
        plan === undefined
            ? "You've hit your Codex usage limit."
            : `You've hit your Codex usage limit on the ChatGPT ${plan} plan.`;
    return usage.resetAt === undefined
        ? `${subject} Try again later.`
        : `${subject} Try again at ${formatCodexResetTime(usage.resetAt, now)}.`;
}

function describeCodexPlan(planType: string): string {
    const normalized = planType.trim().toLowerCase();
    return (
        CODEX_PLAN_NAMES.get(normalized) ??
        normalized
            .split(/[_\-\s]+/u)
            .filter((word) => word.length > 0)
            .map((word) => word[0]!.toUpperCase() + word.slice(1))
            .join(" ")
    );
}

/**
 * A reset later today needs only a clock time; anything further out needs the date too.
 *
 * The formatter separates the time from its meridiem with a narrow no-break space, which a
 * terminal is free to render as a missing space, so it is replaced with an ordinary one.
 */
function formatCodexResetTime(resetAt: number, now: number): string {
    const reset = new Date(resetAt);
    const sameDay = reset.toDateString() === new Date(now).toDateString();
    return reset
        .toLocaleString(
            "en-US",
            sameDay
                ? { hour: "numeric", minute: "2-digit" }
                : {
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                      month: "short",
                      year: "numeric",
                  },
        )
        .replaceAll(/[\u00a0\u202f]/gu, " ");
}

/** Detects a server rejection that can be retried with a smaller compaction input. */
export function isCodexContextWindowError(error: unknown): boolean {
    if (hasErrorCode(error, "context_length_exceeded", new Set())) return true;
    const message = error instanceof Error ? error.message : String(error);
    return /context window|context length|maximum context|too many tokens|prompt tokens.+exceed.+model maximum/iu.test(
        message,
    );
}

const PREVIOUS_RESPONSE_NOT_FOUND = "previous_response_not_found";

export function isCodexPreviousResponseNotFoundError(error: unknown): boolean {
    const seen = new Set<object>();
    const matches = (value: unknown): boolean => {
        if (typeof value === "string") return value.includes(PREVIOUS_RESPONSE_NOT_FOUND);
        if (typeof value !== "object" || value === null || seen.has(value)) return false;
        seen.add(value);
        const record = value as Record<string, unknown>;
        if (record.code === PREVIOUS_RESPONSE_NOT_FOUND) return true;
        return [record.error, record.cause, record.body, record.message].some(matches);
    };
    return matches(error);
}

const MISSING_TOOL_OUTPUT =
    /No tool output found for (?:function|custom tool) call ([A-Za-z0-9_-]+)/u;

/** Reads the call identity from Codex's deterministic incomplete-tool-history rejection. */
export function readCodexMissingToolOutputCallId(error: unknown): string | undefined {
    const seen = new Set<object>();
    const read = (value: unknown): string | undefined => {
        if (typeof value === "string") return MISSING_TOOL_OUTPUT.exec(value)?.[1];
        if (typeof value !== "object" || value === null || seen.has(value)) return undefined;
        seen.add(value);
        const record = value as Record<string, unknown>;
        for (const candidate of [record.error, record.cause, record.body, record.message]) {
            const callId = read(candidate);
            if (callId !== undefined) return callId;
        }
        return undefined;
    };
    return read(error);
}

export function isCodexUnauthorizedError(error: unknown): boolean {
    return hasUnauthorized(error, new Set());
}

const BEDROCK_EXPIRED_SIGNATURE_MESSAGE =
    "Amazon Bedrock rejected the request because its AWS signature has expired. Refresh your " +
    "AWS credentials and retry. If AWS_BEARER_TOKEN_BEDROCK is set, update or unset it, then " +
    "start a new session.";

/**
 * Turns a failure into the sentence shown to a person.
 *
 * An exhausted account and an expired AWS signature both read as bare status codes, which tell the
 * reader nothing about the account that ran out or the credential that went stale, so each is named
 * the way the native client names it. Everything else already describes itself.
 */
export function codexErrorMessage(error: unknown, message: string): string {
    const usage = readCodexUsageExhaustion(error);
    if (usage !== undefined) return codexUsageExhaustionMessage(usage);
    if (isCodexUnauthorizedError(error) && message.includes("Signature expired:")) {
        return BEDROCK_EXPIRED_SIGNATURE_MESSAGE;
    }
    const serverMessage = isWebSocketError(error)
        ? stringProperty(readWebSocketServerError(error), "message")?.trim()
        : undefined;
    if (serverMessage !== undefined && serverMessage.length > 0) return serverMessage;
    return message;
}

/**
 * A rejected WebSocket upgrade never becomes an API error object, so its status only survives in
 * the handshake sentence. Reading it here lets credential recovery run for a WebSocket 401 the
 * same way it does for an SSE one.
 */
function hasUnauthorized(error: unknown, seen: Set<object>): boolean {
    if (typeof error !== "object" || error === null || seen.has(error)) return false;
    seen.add(error);
    if ("status" in error && error.status === 401) return true;
    if (readCodexWebSocketHandshakeStatus(stringProperty(error, "message")) === 401) return true;
    return "cause" in error && hasUnauthorized(error.cause, seen);
}

export function isCodexWebSocketUnavailableError(error: unknown): boolean {
    const details = readDetails(error, new Set());
    if (details.statuses.some((status) => status === 404 || status === 405 || status === 426))
        return true;
    if (
        details.messages.some((message) =>
            /websocket connection.+failed:\s*expected 101 status code/iu.test(message),
        )
    ) {
        return true;
    }
    return (
        details.statuses.includes(400) &&
        details.messages.some((message) =>
            /\bwebsocket\b.*\b(not supported|unsupported|unavailable|upgrade required)\b/i.test(
                message,
            ),
        )
    );
}

function readDetails(
    error: unknown,
    seen: Set<object>,
): { messages: string[]; statuses: number[] } {
    if (typeof error !== "object" || error === null || seen.has(error))
        return { messages: [], statuses: [] };
    seen.add(error);
    const nested =
        "cause" in error
            ? readDetails((error as { cause?: unknown }).cause, seen)
            : { messages: [], statuses: [] };
    const numericStatus =
        "status" in error && typeof (error as { status?: unknown }).status === "number"
            ? [(error as { status: number }).status]
            : [];
    const message =
        "message" in error && typeof (error as { message?: unknown }).message === "string"
            ? [(error as { message: string }).message]
            : [];
    const messageStatus = message
        .map(readCodexWebSocketHandshakeStatus)
        .filter((status): status is number => status !== undefined);
    return {
        messages: [...message, ...nested.messages],
        statuses: [...numericStatus, ...messageStatus, ...nested.statuses],
    };
}

export function isRetryableCodexStreamError(error: unknown): boolean {
    if (isEmptyResponseError(error)) return true;
    if (hasAbortError(error, new Set())) return false;
    // Repeating the same request cannot supply the tool output it omitted. CodexSession may
    // instead replay one complete caller context when that context proves the output exists.
    if (readCodexMissingToolOutputCallId(error) !== undefined) return false;
    // A spent account is the one 429 that waiting cannot fix, and retrying it costs the person
    // minutes of backoff before they are told. Every other 429, including Bedrock throttling,
    // stays retryable below.
    if (readCodexUsageExhaustion(error) !== undefined) return false;
    return shouldRetry(error, new Set());
}

/** Unknown inference failures are transient unless the provider proves they are fatal. */
function shouldRetry(error: unknown, seen: Set<object>): boolean {
    if (typeof error === "object" && error !== null) {
        if (seen.has(error)) return false;
        seen.add(error);
    }
    const code = stringProperty(error, "code") ?? stringProperty(error, "errno");
    const serverError = readWebSocketServerError(error);
    const providerCodes = [
        code,
        serverError === undefined ? undefined : stringProperty(serverError, "type"),
        serverError === undefined ? undefined : stringProperty(serverError, "code"),
    ];
    if (
        providerCodes.some(
            (providerCode) =>
                providerCode !== undefined && FATAL_CODES.has(providerCode.toLowerCase()),
        )
    )
        return false;
    if (
        providerCodes.some(
            (providerCode) =>
                providerCode !== undefined &&
                RETRYABLE_PROVIDER_CODES.has(providerCode.toLowerCase()),
        )
    )
        return true;
    const directive = readCodexErrorHeader(error, "x-should-retry")?.trim().toLowerCase();
    if (directive === "true") return true;
    if (directive === "false") return false;
    if (isCodexWebSocketConnectionLimitError(error)) return true;
    if (isCodexWebSocketRetryableServerError(error)) return true;
    const status =
        numericProperty(error, "status") ??
        readCodexWebSocketHandshakeStatus(stringProperty(error, "message"));
    if (status !== undefined) {
        if (status === 408 || status === 409 || status === 429 || status >= 500) return true;
        if (status >= 400 && status < 500) return false;
    }
    if (code !== undefined && RETRYABLE_CODES.has(code.toUpperCase())) return true;
    if (isCodexContextWindowError(error)) return false;
    if (isWebSocketError(error)) {
        if (readWebSocketServerEvent(error) === undefined) return true;
    } else {
        const name = stringProperty(error, "name");
        if (name !== undefined && RETRYABLE_NAMES.has(name)) return true;
    }
    const message = error instanceof Error ? error.message : "";
    if (RETRYABLE_MESSAGE.test(message)) return true;
    const cause =
        typeof error === "object" && error !== null && "cause" in error
            ? (error as { cause?: unknown }).cause
            : undefined;
    return cause === undefined ? true : shouldRetry(cause, seen);
}

function hasAbortError(error: unknown, seen: Set<object>): boolean {
    if (isAbortError(error)) return true;
    if (typeof error !== "object" || error === null || seen.has(error)) return false;
    seen.add(error);
    return "cause" in error && hasAbortError((error as { cause?: unknown }).cause, seen);
}

const RETRYABLE_CODES = new Set([
    "ECONNABORTED",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETDOWN",
    "ENETUNREACH",
    "ENOTFOUND",
    "EPIPE",
    "ETIMEDOUT",
]);

const RETRYABLE_NAMES = new Set([
    "APIConnectionError",
    "APIConnectionTimeoutError",
    "TimeoutError",
]);

const RETRYABLE_PROVIDER_CODES = new Set([
    "invalid_prompt",
    "invalid_request_error",
    "model_not_found",
    "permission_error",
]);

const FATAL_CODES = new Set([
    "authentication_error",
    "billing_error",
    "bio_policy",
    "content_policy_violation",
    "context_length_exceeded",
    "cyber_policy",
    "empty_image_file",
    "image_content_policy_violation",
    "image_file_not_found",
    "image_file_too_large",
    "image_parse_error",
    "image_too_large",
    "image_too_small",
    // An account with no credit left answers every attempt the same way, so waiting only delays
    // the sentence that tells the person to top it up.
    "insufficient_quota",
    "invalid_base64_image",
    "invalid_image",
    "invalid_image_format",
    "invalid_image_mode",
    "invalid_image_url",
    "unsupported_image_media_type",
]);

function hasErrorCode(error: unknown, expected: string, seen: Set<object>): boolean {
    if (typeof error !== "object" || error === null || seen.has(error)) return false;
    seen.add(error);
    if (stringProperty(error, "code") === expected) return true;
    return ["cause", "error"].some(
        (property) =>
            property in error &&
            hasErrorCode((error as Record<string, unknown>)[property], expected, seen),
    );
}

const WEBSOCKET_ERROR_NAME = "WebSocketError";

/**
 * The OpenAI SDK reports two very different failures through one wrapper: a transport fault it
 * observed itself, and a rejection the server described in an error event. Only the first is a
 * reason to reconnect, so the server event decides which one arrived. The wrapper's runtime `name`
 * stays `"Error"`, so recognition goes through the constructor.
 */
function isWebSocketError(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    return (
        stringProperty(error, "name") === WEBSOCKET_ERROR_NAME ||
        error.constructor?.name === WEBSOCKET_ERROR_NAME
    );
}

function readWebSocketServerEvent(error: unknown): Record<string, unknown> | undefined {
    if (typeof error !== "object" || error === null) return undefined;
    const event = (error as { error?: unknown }).error;
    return typeof event === "object" && event !== null
        ? (event as Record<string, unknown>)
        : undefined;
}

function readWebSocketServerError(error: unknown): Record<string, unknown> | undefined {
    const event = readWebSocketServerEvent(error);
    if (event === undefined) return undefined;
    const nested = event.error;
    return typeof nested === "object" && nested !== null
        ? (nested as Record<string, unknown>)
        : event;
}

const WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";
const WEBSOCKET_CONNECTION_LIMIT_REACHED_MESSAGE = /responses websocket connection limit reached/iu;
const RETRYABLE_WEBSOCKET_SERVER_ERROR_CODES = new Set(["internal_error", "server_error"]);

/**
 * The hourly connection limit arrives as a server error event rather than a transport fault, and
 * the native client answers it by opening a new connection, so it stays retryable even though the
 * other server events do not.
 */
function isCodexWebSocketConnectionLimitError(error: unknown): boolean {
    const event = readWebSocketServerEvent(error);
    const serverError = readWebSocketServerError(error);
    const texts = [
        stringProperty(error, "message"),
        stringProperty(error, "code"),
        event === undefined ? undefined : stringProperty(event, "message"),
        event === undefined ? undefined : stringProperty(event, "code"),
        serverError === undefined ? undefined : stringProperty(serverError, "message"),
        serverError === undefined ? undefined : stringProperty(serverError, "code"),
    ];
    return texts.some(
        (text) =>
            text !== undefined &&
            (text.includes(WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE) ||
                WEBSOCKET_CONNECTION_LIMIT_REACHED_MESSAGE.test(text)),
    );
}

function isCodexWebSocketRetryableServerError(error: unknown): boolean {
    const serverError = readWebSocketServerError(error);
    if (serverError === undefined) return false;
    return [stringProperty(serverError, "type"), stringProperty(serverError, "code")].some(
        (value) => value !== undefined && RETRYABLE_WEBSOCKET_SERVER_ERROR_CODES.has(value),
    );
}

const RETRYABLE_MESSAGE =
    /\b(connection (?:closed|dropped|failed|lost|reset)|fetch failed|network error|socket (?:closed|disconnected|error|hang up)|stream (?:closed|disconnected)|timed? out|websocket (?:closed|disconnected|error))\b/i;

function readCodexWebSocketHandshakeStatus(message: string | undefined): number | undefined {
    const match = message?.match(/\bUnexpected server response:\s*(\d{3})\b/iu);
    if (match?.[1] === undefined) return undefined;
    const status = Number(match[1]);
    return status >= 100 && status <= 599 ? status : undefined;
}

function isAbortError(error: unknown): boolean {
    return (
        (error instanceof DOMException && error.name === "AbortError") ||
        stringProperty(error, "name") === "AbortError"
    );
}

function numericProperty(error: unknown, property: string): number | undefined {
    if (typeof error !== "object" || error === null || !(property in error)) return undefined;
    const value = (error as Record<string, unknown>)[property];
    return typeof value === "number" ? value : undefined;
}

function stringProperty(error: unknown, property: string): string | undefined {
    if (typeof error !== "object" || error === null || !(property in error)) return undefined;
    const value = (error as Record<string, unknown>)[property];
    return typeof value === "string" ? value : undefined;
}

export function readCodexErrorHeader(error: unknown, name: string): string | undefined {
    return readHeader(error, name.toLowerCase(), new Set());
}

function readHeader(error: unknown, name: string, seen: Set<object>): string | undefined {
    if (typeof error !== "object" || error === null || seen.has(error)) return undefined;
    seen.add(error);
    if ("headers" in error) {
        const headers = (error as { headers?: unknown }).headers;
        if (typeof Headers !== "undefined" && headers instanceof Headers) {
            const value = headers.get(name);
            if (value !== null) return value;
        } else if (typeof headers === "object" && headers !== null) {
            const record = headers as Record<string, unknown>;
            const value =
                record[name] ??
                Object.entries(record).find(([key]) => key.toLowerCase() === name)?.[1];
            if (typeof value === "string") return value;
        }
    }
    return "cause" in error
        ? readHeader((error as { cause?: unknown }).cause, name, seen)
        : undefined;
}
