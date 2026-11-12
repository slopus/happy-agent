import { testContext } from "./testContext.js";

import { describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@/core/SessionEvent.js";
import { ClaudeAuthTokenCredential } from "@/vendors/claude/ClaudeAuthTokenCredential.js";
import { ClaudeSession, type ClaudeSdkQuery } from "@/vendors/claude/ClaudeSession.js";

describe("Claude retry classification", () => {
    it.each([
        [401, "authentication_failed", { type: "authentication" }],
        [403, "authentication_failed", { type: "authentication" }],
        [529, "overloaded", { type: "server_overloaded" }],
        [500, "server_error", { type: "internal_server_error" }],
        [429, "rate_limit", { type: "rate_limit" }],
        [null, "unknown", { type: "network" }],
    ] as const)(
        "names an HTTP %s %s retry by what failed",
        async (status, error, providerError) => {
            const events = await run(() =>
                sdkMessages([
                    apiRetry(1, status, error),
                    syntheticError("Failed to authenticate.", "authentication_failed"),
                    result({ isError: true, text: "Failed to authenticate." }),
                ]),
            );

            const retry = events.find((event) => event.type === "retrying");
            expect(retry).toMatchObject({ providerError });
            expect(retry).toMatchObject({
                providerError: {
                    diagnostics: {
                        attempts: 1,
                        code: error,
                        ...(status === null ? {} : { status }),
                    },
                },
            });
        },
    );

    it("ends a refused login without spending the empty-response retries", async () => {
        // Claude Code answers a login it cannot use with a synthetic assistant error. Should its
        // result arrive without `is_error`, the refusal is still the outcome.
        const query = vi.fn(() =>
            sdkMessages([
                syntheticError("Not logged in · Please run /login", "authentication_failed"),
                result({ isError: false, text: "Not logged in · Please run /login" }),
            ]),
        );

        const events = await run(query);

        expect(query).toHaveBeenCalledOnce();
        expect(events.filter((event) => event.type === "retrying")).toEqual([]);
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            message: "Not logged in · Please run /login",
            providerError: { type: "authentication" },
        });
    });

    it("still answers a recovered turn whose assistant error preceded real output", async () => {
        const events = await run(() =>
            sdkMessages([
                syntheticError("Response cut off.", "max_output_tokens"),
                result({ isError: false, text: "Recovered answer.", outputTokens: 3 }),
            ]),
        );

        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
    });
});

async function run(query: () => ReturnType<ClaudeSdkQuery>): Promise<SessionEvent[]> {
    const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
    if (credential === null) throw new Error("Expected test credential.");
    const session = new ClaudeSession("retry-classification", {
        instructions: "",
        credential,
        model: "opus[1m]",
        query: query as unknown as ClaudeSdkQuery,
        tools: [],
        waitForInferenceRetry: async () => {},
    });
    const events: SessionEvent[] = [];
    try {
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [{ role: "user", content: [{ type: "text", text: "Hello." }] }],
            },
        })) {
            events.push(event);
        }
    } finally {
        session.destroy();
    }
    return events;
}

function sdkMessages(messages: readonly Record<string, unknown>[]): ReturnType<ClaudeSdkQuery> {
    async function* stream() {
        yield* messages;
    }
    return Object.assign(stream(), { close: () => {} }) as unknown as ReturnType<ClaudeSdkQuery>;
}

function apiRetry(attempt: number, status: number | null, error: string) {
    return {
        type: "system",
        subtype: "api_retry",
        attempt,
        max_retries: 10,
        retry_delay_ms: 500,
        error_status: status,
        error,
        uuid: `retry-${attempt}`,
        session_id: "retry-classification",
    };
}

// The shape Claude Code 2.1.321 emits for a failure it answers itself: model `<synthetic>`, no
// output, and the assistant error code beside the message.
function syntheticError(text: string, error: string) {
    return {
        type: "assistant",
        error,
        message: {
            id: "synthetic-id",
            type: "message",
            role: "assistant",
            model: "<synthetic>",
            content: [{ type: "text", text }],
            stop_reason: "stop_sequence",
            stop_sequence: "",
            usage: {
                input_tokens: 0,
                output_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
        },
        parent_tool_use_id: null,
        uuid: "synthetic-uuid",
        session_id: "retry-classification",
    };
}

function result(options: { isError: boolean; text: string; outputTokens?: number }) {
    return {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 0,
        is_error: options.isError,
        num_turns: 1,
        result: options.text,
        stop_reason: "stop_sequence",
        total_cost_usd: 0,
        usage: {
            input_tokens: 0,
            output_tokens: options.outputTokens ?? 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        },
        modelUsage: {},
        permission_denials: [],
        uuid: "result-uuid",
        session_id: "retry-classification",
    };
}
