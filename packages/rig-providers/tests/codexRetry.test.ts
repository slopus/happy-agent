import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebSocketError } from "openai/resources/responses/internal-base";
import { describe, expect, it } from "vitest";

import { CodexProvider } from "@/vendors/codex/CodexProvider.js";
import { formatCodexUserAgent } from "@/vendors/codex/impl/codexUserAgent.js";
import {
    classifyCodexError,
    classifyCodexProviderError,
} from "@/vendors/codex/errors/codexErrors.js";
import { codexErrorMessage } from "@/vendors/codex/errors/codexErrors.js";
import { isCodexContextWindowError } from "@/vendors/codex/errors/codexErrors.js";
import { isRetryableCodexStreamError } from "@/vendors/codex/errors/codexErrors.js";
import { isCodexPreviousResponseNotFoundError } from "@/vendors/codex/errors/codexErrors.js";
import { isCodexUnauthorizedError } from "@/vendors/codex/errors/codexErrors.js";
import { isCodexWebSocketUnavailableError } from "@/vendors/codex/errors/codexErrors.js";
import { collectCodexCompaction } from "@/vendors/codex/impl/codexCompaction.js";
import { resolveCodexInstallationId } from "@/vendors/codex/impl/resolveCodexInstallationId.js";
import { resolveCodexInstallationIdAt } from "@/vendors/codex/impl/resolveCodexInstallationIdAt.js";
import {
    resolveCodexRetryDelay,
    resolveCodexStreamIdleTimeout,
    waitForCodexRetry,
} from "@/vendors/codex/impl/codexRetry.js";
import { resolveInferenceMaxRetries } from "@/core/inferenceRetrySettings.js";

describe("Codex stream retries", () => {
    it("classifies a generic HTTP 500 as an internal server error", () => {
        const error = Object.assign(new Error("request failed"), { status: 500 });

        expect(classifyCodexProviderError(error, error.message, 1)).toMatchObject({
            type: "internal_server_error",
            diagnostics: { attempts: 1, status: 500 },
        });
    });

    it("recognizes the Bedrock prompt-token overflow returned during compaction", () => {
        expect(
            isCodexContextWindowError(
                new Error("prompt tokens (286638) exceed customer model maximum (278528)"),
            ),
        ).toBe(true);
        expect(
            isCodexContextWindowError(
                Object.assign(new Error("Request failed."), {
                    code: "context_length_exceeded",
                }),
            ),
        ).toBe(true);
    });

    it("keeps an HTTP status in non-WebSocket diagnostic errors", () => {
        const message = "403 User is not authorized to invoke this operation.";
        const error = Object.assign(new Error(message), {
            error: { message: "User is not authorized to invoke this operation." },
            status: 403,
        });

        expect(codexErrorMessage(error, message)).toBe(message);
    });

    it("recognizes a missing previous response from structured and serialized API errors", () => {
        const responseError = {
            type: "invalid_request_error",
            code: "previous_response_not_found",
            message: "Previous response was not found.",
            param: "previous_response_id",
        };

        expect(
            isCodexPreviousResponseNotFoundError({
                error: responseError,
                status: 400,
            }),
        ).toBe(true);
        expect(
            isCodexPreviousResponseNotFoundError(
                new Error(JSON.stringify({ type: "error", error: responseError, status: 400 })),
            ),
        ).toBe(true);
        expect(
            isCodexPreviousResponseNotFoundError(
                Object.assign(new Error("invalid request"), { status: 400 }),
            ),
        ).toBe(false);
    });

    it("formats the native user agent from runtime identity", () => {
        expect(
            formatCodexUserAgent({
                architecture: "arm64",
                osType: "Mac OS",
                osVersion: "26.5.2",
                terminal: "unknown",
                version: "0.145.0",
            }),
        ).toBe("codex_exec/0.145.0 (Mac OS 26.5.2; arm64) unknown (codex_exec; 0.145.0)");
    });

    it.each([
        Object.assign(new Error("request failed"), { status: 408 }),
        Object.assign(new Error("request failed"), { status: 429 }),
        Object.assign(new Error("request failed"), { status: 500 }),
        Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
        Object.assign(new Error("request failed"), { name: "APIConnectionError" }),
        Object.assign(new TypeError("request failed"), {
            cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
        }),
        new Error("socket disconnected"),
        new Error("The server had an error while processing your request. Sorry about that!"),
        new Error("invalid response payload"),
    ])("recognizes retryable transport errors", (error) => {
        expect(isRetryableCodexStreamError(error)).toBe(true);
    });

    it("recognizes the real OpenAI WebSocket wrapper for a rejected 503 handshake", () => {
        const cause = new Error("Unexpected server response: 503");
        const error = new WebSocketError(cause.message, null);
        error.cause = cause;
        const unauthorized = new WebSocketError("Unexpected server response: 401", null);
        const unavailable = new WebSocketError("Unexpected server response: 426", null);
        const disconnected = new WebSocketError("cannot send on a closed WebSocket", null);

        expect(error.constructor.name).toBe("WebSocketError");
        expect(error.name).toBe("Error");
        expect(isRetryableCodexStreamError(error)).toBe(true);
        expect(isRetryableCodexStreamError(unauthorized)).toBe(false);
        expect(isCodexWebSocketUnavailableError(unavailable)).toBe(true);
        expect(isRetryableCodexStreamError(disconnected)).toBe(true);
    });

    it("retries WebSocket server rejections unless their code proves they are terminal", () => {
        const rejected = new WebSocketError("Invalid 'input': expected an array.", {
            type: "error",
            code: "invalid_request_error",
            message: "Invalid 'input': expected an array.",
            param: "input",
            sequence_number: 1,
        });
        const policyRejected = new WebSocketError("Policy rejected the request.", {
            type: "error",
            code: "cyber_policy",
            message: "Policy rejected the request.",
            param: "input",
            sequence_number: 2,
        });
        const connectionLimit = new WebSocketError(
            "Responses websocket connection limit reached (60 minutes). Create a new websocket " +
                "connection to continue.",
            {
                type: "error",
                code: "websocket_connection_limit_reached",
                message:
                    "Responses websocket connection limit reached (60 minutes). Create a new " +
                    "websocket connection to continue.",
                param: null,
                sequence_number: 2,
            },
        );

        expect(isRetryableCodexStreamError(rejected)).toBe(true);
        expect(isRetryableCodexStreamError(policyRejected)).toBe(false);
        expect(isRetryableCodexStreamError(connectionLimit)).toBe(true);
    });

    it("retries and humanizes Codex WebSocket internal server errors", () => {
        const event = {
            type: "error",
            error: {
                type: "internal_error",
                code: "internal_error",
                message: "Internal server error",
                param: null,
            },
            sequence_number: 285,
        };
        const message = JSON.stringify(event);
        const error = new WebSocketError(message, event as never);

        expect(isRetryableCodexStreamError(error)).toBe(true);
        expect(classifyCodexError(message)).toBe("internal_error");
        expect(codexErrorMessage(error, message)).toBe("Internal server error");
    });

    it("retries and humanizes Codex WebSocket server errors", () => {
        const serverMessage =
            "An error occurred while processing your request. You can retry your request. " +
            "Please include the request ID 2ec492f3-b41e-4329-a884-c3c2b024e1c5.";
        const event = {
            type: "error",
            error: {
                type: "server_error",
                code: "server_error",
                message: serverMessage,
                param: null,
            },
            sequence_number: 6,
        };
        const message = JSON.stringify(event);
        const error = new WebSocketError(message, event as never);

        expect(isRetryableCodexStreamError(error)).toBe(true);
        expect(classifyCodexError(message)).toBe("internal_error");
        expect(codexErrorMessage(error, message)).toBe(serverMessage);
    });

    it("recovers the credential for a WebSocket handshake rejected as unauthorized", () => {
        expect(
            isCodexUnauthorizedError(new WebSocketError("Unexpected server response: 401", null)),
        ).toBe(true);
        expect(
            isCodexUnauthorizedError(new WebSocketError("Unexpected server response: 503", null)),
        ).toBe(false);
    });

    it("reads a rejected handshake as a server-side failure", () => {
        expect(classifyCodexError("Unexpected server response: 503")).toBe("internal_error");
        expect(classifyCodexError("Unexpected server response: 500")).toBe("internal_error");
        expect(classifyCodexError("Unexpected server response: 400")).toBe("unknown");
    });

    it.each([
        ["insufficient_quota", 429],
        ["invalid_prompt", 400],
        ["invalid_request_error", 400],
        ["model_not_found", 404],
        ["permission_error", 403],
    ])("retries provider code %s instead of treating HTTP %i as terminal", (code, status) => {
        expect(
            isRetryableCodexStreamError(
                Object.assign(new Error("The provider rejected the request."), {
                    code,
                    headers: { "x-should-retry": "false" },
                    status,
                }),
            ),
        ).toBe(true);
    });

    it.each([
        Object.assign(new Error("bad request"), { status: 400 }),
        Object.assign(new Error("unauthorized"), { status: 401 }),
        Object.assign(new Error("Policy rejected the request."), {
            code: "bio_policy",
            headers: { "x-should-retry": "true" },
            status: 500,
        }),
        Object.assign(new Error("Policy rejected the request."), {
            code: "content_policy_violation",
            headers: { "x-should-retry": "true" },
            status: 500,
        }),
        Object.assign(new Error("Policy rejected the request."), {
            code: "cyber_policy",
            headers: { "x-should-retry": "true" },
            status: 500,
        }),
        Object.assign(new Error("Request failed."), { code: "context_length_exceeded" }),
        new DOMException("Request was aborted", "AbortError"),
    ])("does not retry explicitly fatal errors", (error) => {
        expect(isRetryableCodexStreamError(error)).toBe(false);
    });

    it("preserves response codes from Codex compaction", async () => {
        const events = (async function* () {
            yield {
                type: "response.failed",
                response: {
                    error: { code: "invalid_prompt", message: "Compaction prompt was rejected." },
                },
            } as never;
        })();

        await expect(collectCodexCompaction(events, {})).rejects.toMatchObject({
            code: "invalid_prompt",
            message: "Compaction prompt was rejected.",
        });
    });

    it("rejects a retry delay immediately when already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(waitForCodexRetry(100, undefined, controller.signal)).rejects.toMatchObject({
            name: "AbortError",
        });
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
        "rejects an invalid retry limit",
        (value) => {
            expect(() => resolveInferenceMaxRetries(value)).toThrow(
                "inferenceMaxRetries must be a finite nonnegative integer.",
            );
            expect(
                () =>
                    new CodexProvider({
                        credential: {
                            name: "codex-api-key",
                            credential: { apiKey: "test" },
                        },
                        inferenceMaxRetries: value,
                    }),
            ).toThrow("inferenceMaxRetries must be a finite nonnegative integer.");
        },
    );

    it("caps retry limits to the upstream maximum", () => {
        expect(resolveInferenceMaxRetries(101)).toBe(100);
    });

    it("resolves the retry limit again for a long-lived provider", () => {
        let inferenceMaxRetries = 1;
        const provider = new CodexProvider({
            credential: {
                name: "codex-api-key",
                credential: { apiKey: "test" },
            },
            resolveInferenceMaxRetries: () => inferenceMaxRetries,
        });

        expect(provider.inferenceMaxRetries).toBe(1);
        inferenceMaxRetries = 3;
        expect(provider.inferenceMaxRetries).toBe(3);
    });

    it("uses one persisted installation identity across sessions", async () => {
        const first = await resolveCodexInstallationId();
        const second = await resolveCodexInstallationId();
        expect(first).toBe(second);
        expect(first).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        );
    });

    it("creates one durable installation identity across concurrent resolvers", async () => {
        const codexHome = await mkdtemp(join(tmpdir(), "rig-codex-installation-"));
        try {
            const resolved = await Promise.all(
                Array.from({ length: 20 }, () => resolveCodexInstallationIdAt(codexHome)),
            );
            expect(new Set(resolved)).toEqual(new Set([resolved[0]]));
            expect((await readFile(join(codexHome, "installation_id"), "utf8")).trim()).toBe(
                resolved[0],
            );
            await chmod(join(codexHome, "installation_id"), 0o600);
            expect(await resolveCodexInstallationIdAt(codexHome)).toBe(resolved[0]);
            expect((await stat(join(codexHome, "installation_id"))).mode & 0o777).toBe(0o644);
        } finally {
            await rm(codexHome, { force: true, recursive: true });
        }
    });

    it("uses the upstream stream idle timeout and validates overrides", () => {
        expect(resolveCodexStreamIdleTimeout()).toBe(300_000);
        expect(resolveCodexStreamIdleTimeout(25)).toBe(25);
        expect(() => resolveCodexStreamIdleTimeout(0)).toThrow(
            "streamIdleTimeoutMs must be a finite positive integer.",
        );
    });

    it("honors explicit server retry directives before status defaults", () => {
        expect(
            isRetryableCodexStreamError({
                status: 500,
                headers: new Headers({ "x-should-retry": "false" }),
            }),
        ).toBe(false);
        expect(
            isRetryableCodexStreamError({
                status: 400,
                headers: { "x-should-retry": "true" },
            }),
        ).toBe(true);
        expect(
            isRetryableCodexStreamError({
                code: "invalid_prompt",
                headers: { "x-should-retry": "false" },
            }),
        ).toBe(true);
    });

    it("uses bounded server retry delays before exponential backoff", () => {
        expect(
            resolveCodexRetryDelay(1, {
                headers: new Headers({ "retry-after-ms": "1750" }),
            }),
        ).toBe(1_750);
        expect(resolveCodexRetryDelay(2, { headers: { "retry-after": "1.25" } })).toBe(1_250);
        expect(resolveCodexRetryDelay(3, undefined, () => 0.5)).toBe(800);
        expect(
            resolveCodexRetryDelay(1, { headers: { "retry-after-ms": "999999" } }, () => 0.5),
        ).toBe(200);
    });

    it("separates WebSocket capability failures from inference retryability", () => {
        expect(isCodexWebSocketUnavailableError({ status: 404 })).toBe(true);
        expect(isCodexWebSocketUnavailableError({ status: 405 })).toBe(true);
        expect(isCodexWebSocketUnavailableError({ status: 426 })).toBe(true);
        expect(
            isCodexWebSocketUnavailableError({
                status: 400,
                message: "Responses WebSocket is not supported.",
            }),
        ).toBe(true);
        expect(isCodexWebSocketUnavailableError({ status: 400, message: "Invalid input" })).toBe(
            false,
        );
        expect(
            isCodexWebSocketUnavailableError({
                status: 400,
                message: "Request failed",
                cause: new Error("Responses WebSocket is unavailable."),
            }),
        ).toBe(true);
    });

    it("never retries an abort hidden under a retryable transport wrapper", () => {
        const abort = new DOMException("Request was aborted", "AbortError");
        expect(
            isRetryableCodexStreamError(
                Object.assign(new Error("socket disconnected", { cause: abort }), {
                    code: "ECONNRESET",
                }),
            ),
        ).toBe(false);
    });
});
