import { Type, type Static } from "@sinclair/typebox";

export const apiErrorCodeSchema = Type.Union([
    Type.Literal("conflict"),
    Type.Literal("cursor_unavailable"),
    Type.Literal("draining"),
    Type.Literal("hash_mismatch"),
    Type.Literal("happy_unavailable"),
    Type.Literal("internal"),
    Type.Literal("invalid_request"),
    Type.Literal("not_found"),
    Type.Literal("not_initialized"),
    Type.Literal("too_large"),
    Type.Literal("unauthorized"),
    Type.Literal("unsupported"),
]);

export type ApiErrorCode = Static<typeof apiErrorCodeSchema>;

/** A failure that is safe to return across the local HTTP boundary. */
export class ApiError extends Error {
    readonly status: number;
    readonly code: ApiErrorCode;
    readonly details: Readonly<Record<string, unknown>>;

    constructor(
        status: number,
        code: ApiErrorCode,
        message: string,
        details: Readonly<Record<string, unknown>> = {},
    ) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.code = code;
        this.details = details;
    }

    body(): Readonly<Record<string, unknown>> {
        return { error: this.message, code: this.code, ...this.details };
    }
}

export function invalidRequest(message: string): ApiError {
    return new ApiError(400, "invalid_request", message);
}

export function notFound(message: string): ApiError {
    return new ApiError(404, "not_found", message);
}

export function unsupported(message: string): ApiError {
    return new ApiError(501, "unsupported", message);
}
