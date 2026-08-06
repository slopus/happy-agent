import type { SessionProviderErrorDiagnostics } from "@/core/SessionProviderError.js";

const IDENTIFIER_LIMIT = 256;
const MESSAGE_LIMIT = 2_048;
const TRAVERSAL_LIMIT = 24;

/**
 * Extracts only the bounded, non-secret fields useful for diagnosing a provider failure.
 *
 * Provider SDK errors vary, but they consistently put useful details on a small set of fields,
 * nested causes, or response headers. Raw bodies and arbitrary headers are deliberately excluded.
 */
export function extractProviderErrorDiagnostics(
    error: unknown,
    overrides: Partial<SessionProviderErrorDiagnostics> = {},
): SessionProviderErrorDiagnostics | undefined {
    const records = collectRecords(error);
    const status =
        validStatus(overrides.status) ??
        firstNumber(records, ["status", "statusCode", "status_code"], validStatus);
    const code =
        boundIdentifier(overrides.code) ??
        firstString(records, ["code", "errorCode", "error_code"], boundIdentifier);
    const errorType =
        boundIdentifier(overrides.errorType) ??
        firstString(records, ["errorType", "error_type", "type"], boundIdentifier);
    const requestId =
        boundIdentifier(overrides.requestId) ??
        firstString(
            records,
            ["requestId", "request_id", "requestID", "request-id"],
            boundIdentifier,
        ) ??
        firstHeader(records, [
            "x-request-id",
            "request-id",
            "x-amzn-requestid",
            "x-amzn-request-id",
            "x-amz-request-id",
            "anthropic-request-id",
        ]);
    const responseId =
        boundIdentifier(overrides.responseId) ??
        firstString(records, ["responseId", "response_id"], boundIdentifier);
    const retryDirective =
        typeof overrides.retryDirective === "boolean"
            ? overrides.retryDirective
            : parseBoolean(firstHeader(records, ["x-should-retry"]));
    const upstreamMessage =
        boundMessage(overrides.upstreamMessage) ??
        firstString(records, ["message"], boundMessage) ??
        boundMessage(typeof error === "string" ? error : undefined);
    const attempts =
        validAttempts(overrides.attempts) ??
        firstNumber(records, ["attempts", "attempt"], validAttempts);

    const diagnostics: SessionProviderErrorDiagnostics = {
        ...(attempts === undefined ? {} : { attempts }),
        ...(code === undefined ? {} : { code }),
        ...(errorType === undefined ? {} : { errorType }),
        ...(requestId === undefined ? {} : { requestId }),
        ...(responseId === undefined ? {} : { responseId }),
        ...(retryDirective === undefined ? {} : { retryDirective }),
        ...(status === undefined ? {} : { status }),
        ...(upstreamMessage === undefined ? {} : { upstreamMessage }),
    };
    return Object.keys(diagnostics).length === 0 ? undefined : diagnostics;
}

/** Converts a provider retry-after header into the absolute reset timestamp used above transport. */
export function extractProviderRetryResetAt(
    error: unknown,
    now: () => number = Date.now,
): number | undefined {
    const records = collectRecords(error);
    const current = now();
    const milliseconds = finiteNonnegative(firstHeader(records, ["retry-after-ms"]));
    if (milliseconds !== undefined) return current + milliseconds;

    const retryAfter = firstHeader(records, ["retry-after"]);
    const seconds = finiteNonnegative(retryAfter);
    if (seconds !== undefined) return current + seconds * 1_000;
    if (retryAfter === undefined) return undefined;

    const date = Date.parse(retryAfter);
    return Number.isFinite(date) ? Math.max(current, date) : undefined;
}

function collectRecords(value: unknown): Record<string, unknown>[] {
    const records: Record<string, unknown>[] = [];
    const pending: unknown[] = [value];
    const seen = new Set<object>();
    while (pending.length > 0 && records.length < TRAVERSAL_LIMIT) {
        const candidate = pending.shift();
        if (typeof candidate !== "object" || candidate === null || seen.has(candidate)) continue;
        seen.add(candidate);
        const record = candidate as Record<string, unknown>;
        records.push(record);
        for (const key of ["cause", "error", "body", "response"]) {
            if (key in record) pending.push(record[key]);
        }
    }
    return records;
}

function firstNumber(
    records: readonly Record<string, unknown>[],
    keys: readonly string[],
    normalize: (value: unknown) => number | undefined,
): number | undefined {
    for (const record of records) {
        for (const key of keys) {
            const value = normalize(record[key]);
            if (value !== undefined) return value;
        }
    }
    return undefined;
}

function firstString(
    records: readonly Record<string, unknown>[],
    keys: readonly string[],
    normalize: (value: unknown) => string | undefined,
): string | undefined {
    for (const record of records) {
        for (const key of keys) {
            const value = normalize(record[key]);
            if (value !== undefined) return value;
        }
    }
    return undefined;
}

function firstHeader(
    records: readonly Record<string, unknown>[],
    names: readonly string[],
): string | undefined {
    for (const record of records) {
        const headers = record.headers;
        for (const name of names) {
            if (typeof Headers !== "undefined" && headers instanceof Headers) {
                const value = boundIdentifier(headers.get(name) ?? undefined);
                if (value !== undefined) return value;
            } else if (typeof headers === "object" && headers !== null) {
                const entry = Object.entries(headers).find(
                    ([key]) => key.toLowerCase() === name,
                )?.[1];
                const value = boundIdentifier(Array.isArray(entry) ? entry.join(", ") : entry);
                if (value !== undefined) return value;
            }
        }
    }
    return undefined;
}

function boundIdentifier(value: unknown): string | undefined {
    return boundString(value, IDENTIFIER_LIMIT);
}

function boundMessage(value: unknown): string | undefined {
    return boundString(value, MESSAGE_LIMIT);
}

function boundString(value: unknown, limit: number): string | undefined {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim();
    if (normalized.length === 0) return undefined;
    return normalized.length <= limit ? normalized : normalized.slice(0, limit);
}

function validStatus(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 999
        ? value
        : undefined;
}

function validAttempts(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
    if (value?.toLowerCase() === "true") return true;
    if (value?.toLowerCase() === "false") return false;
    return undefined;
}

function finiteNonnegative(value: unknown): number | undefined {
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
