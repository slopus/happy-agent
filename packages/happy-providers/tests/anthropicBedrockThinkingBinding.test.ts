import { AnthropicBedrock, AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { APIError } from "@anthropic-ai/sdk/error";
import { describe, expect, it } from "vitest";

import type { SessionContext } from "@/core/SessionContext.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import { AnthropicBedrockProvider } from "@/vendors/bedrock/AnthropicBedrockProvider.js";
import type { AnthropicBedrockTransport } from "@/vendors/bedrock/AnthropicBedrockTransport.js";
import { BedrockBearerTokenCredential } from "@/vendors/bedrock/BedrockBearerTokenCredential.js";
import {
    dropsMismatchedAnthropicBedrockThinking,
    isAnthropicThinkingBindingRefusal,
} from "@/vendors/bedrock/impl/anthropicBedrockThinkingBinding.js";
import { testContext } from "./testContext.js";

const BETA = "thinking-binding-controls-2026-08-01";
const DROP = { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } };
/** What Bedrock answers when signed thinking is replayed under a different system prompt. */
const MISMATCH =
    'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". That setting requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header. The `system` prompt differs from the one this block was created with.';
/** What the API answers to the field when the beta did not arrive, per the AWS user guide. */
const FIELD_REFUSED = "thinking.adaptive.block_binding: Extra inputs are not permitted";

interface Sent {
    readonly url: string;
    readonly body: Record<string, any>;
}

/**
 * The turn Steve hit: one request produced signed thinking and a tool call under one system
 * prompt, and the next request of the same turn replays it under a prompt that changed.
 */
const replayed: SessionContext = {
    instructions: 'You are the persistent task named "Release Notes".',
    messages: [
        { role: "user", content: [{ type: "text", text: "List the projects." }] },
        {
            role: "assistant",
            content: [
                {
                    type: "reasoning",
                    text: "The project list is the place to start.",
                    reasoning: "signature-made-under-the-old-system-prompt",
                },
                { type: "tool_call", callId: "toolu_list", name: "list_projects", arguments: "{}" },
            ],
        },
        { role: "tool", callId: "toolu_list", content: [{ type: "text", text: "No projects." }] },
    ],
};

describe("Bedrock replay of thinking whose prefix changed", () => {
    it("asks Runtime to drop mismatched thinking on a model that checks the prefix", async () => {
        const sent: Sent[] = [];
        const session = await sessionWith(sent, { model: "anthropic/fable-5-2" });
        try {
            const events = await collect(
                session.run(testContext, { context: replayed, effort: "high" }),
            );
            expect(events.at(-1), JSON.stringify(events)).toMatchObject({
                type: "done",
                state: "normal",
            });
            const compaction = await session.compact(testContext, { context: replayed });
            expect(compaction, JSON.stringify(compaction)).toMatchObject({ status: "completed" });
        } finally {
            session.destroy();
        }

        // Inference and compaction both replay the history, so both carry the control.
        expect(sent).toHaveLength(2);
        for (const request of sent) {
            expect(request.url).toContain("/model/us.anthropic.claude-fable-5-2/");
            expect(request.body.anthropic_beta).toContain(BETA);
            expect(request.body.thinking).toEqual(DROP);
            // The caller's history is sent as it is; dropping is the server's own projection.
            expect(request.body.messages[1].content[0]).toEqual({
                type: "thinking",
                thinking: "The project list is the place to start.",
                signature: "signature-made-under-the-old-system-prompt",
            });
        }
    });

    it("leaves the request alone where the control does not apply", async () => {
        const cases: {
            model: string;
            transport: AnthropicBedrockTransport;
            effort: "high" | "off";
        }[] = [
            // Opus 4.8 never checks the prefix, and earlier models are reported to refuse the field.
            { model: "anthropic/opus-4-8", transport: "runtime", effort: "high" },
            // AWS documents the control for InvokeModel only.
            { model: "anthropic/opus-5-5", transport: "mantle", effort: "high" },
            // The API refuses `block_binding` with thinking disabled.
            { model: "anthropic/fable-5-2", transport: "runtime", effort: "off" },
        ];
        for (const { model, transport, effort } of cases) {
            const sent: Sent[] = [];
            const session = await sessionWith(sent, { model, transport });
            try {
                await collect(session.run(testContext, { context: replayed, effort }));
            } finally {
                session.destroy();
            }
            expect(sent, model).toHaveLength(1);
            const betas: string[] = sent[0]!.body.anthropic_beta ?? sent[0]!.body.betas ?? [];
            expect(betas, model).not.toContain(BETA);
            expect(sent[0]!.body.thinking, model).toEqual(
                effort === "off" ? { type: "disabled" } : { type: "adaptive" },
            );
        }
    });

    it("recognizes the prefix-checked models by caller ID or by Bedrock ID, on Runtime only", () => {
        const drops = (model: string, wireModel = model, transport = "runtime" as const) =>
            dropsMismatchedAnthropicBedrockThinking({ model, transport, wireModel });
        for (const name of [
            "fable-5-2",
            "mythos-5-2",
            "fable-5-1",
            "opus-5-5",
            "sonnet-5-5",
            "haiku-5-5",
        ]) {
            expect(drops(`global.anthropic.claude-${name}`), name).toBe(true);
        }
        // A caller ID mapped to an application inference profile is still recognized.
        expect(
            drops(
                "anthropic/fable-5-2",
                "arn:aws:bedrock:us-east-1:111122223333:application-inference-profile/abc",
            ),
        ).toBe(true);
        expect(drops("us.anthropic.claude-fable-5")).toBe(false);
        expect(drops("us.anthropic.claude-opus-5")).toBe(false);
        expect(drops("us.anthropic.claude-sonnet-5")).toBe(false);
        expect(drops("us.anthropic.claude-opus-4-8")).toBe(false);
        expect(
            drops("arn:aws:bedrock:us-east-1:111122223333:application-inference-profile/abc"),
        ).toBe(false);
        expect(
            dropsMismatchedAnthropicBedrockThinking({
                model: "anthropic/fable-5-2",
                transport: "mantle",
                wireModel: "anthropic.claude-fable-5-2",
            }),
        ).toBe(false);
    });

    it("stops sending the control for the session once the endpoint refuses it", async () => {
        const sent: Sent[] = [];
        const session = await sessionWith(sent, {
            model: "anthropic/fable-5-2",
            answer: (request) =>
                request.body.thinking?.block_binding === undefined
                    ? undefined
                    : invalidRequest(FIELD_REFUSED),
        });
        try {
            const first = await collect(session.run(testContext, { context: replayed }));
            // The refusal is renegotiated, not reported as a failed attempt.
            expect(first.map((event) => event.type)).not.toContain("retrying");
            expect(first.at(-1), JSON.stringify(first)).toMatchObject({
                type: "done",
                state: "normal",
            });
            const second = await collect(session.run(testContext, { context: replayed }));
            expect(second.at(-1)).toMatchObject({ type: "done", state: "normal" });
            const compaction = await session.compact(testContext, { context: replayed });
            expect(compaction).toMatchObject({ status: "completed" });
        } finally {
            session.destroy();
        }

        expect(sent.map((request) => request.body.thinking)).toEqual([
            DROP,
            { type: "adaptive" },
            { type: "adaptive" },
            { type: "adaptive" },
        ]);
        expect(sent.map((request) => request.body.anthropic_beta.includes(BETA))).toEqual([
            true,
            false,
            false,
            false,
        ]);
    });

    it("renegotiates a refusal that arrives on compaction", async () => {
        const sent: Sent[] = [];
        const session = await sessionWith(sent, {
            model: "anthropic/fable-5-2",
            answer: (request) =>
                request.body.anthropic_beta.includes(BETA)
                    ? invalidRequest("invalid beta flag")
                    : undefined,
        });
        try {
            const compaction = await session.compact(testContext, { context: replayed });
            expect(compaction, JSON.stringify(compaction)).toMatchObject({ status: "completed" });
        } finally {
            session.destroy();
        }
        expect(sent.map((request) => request.body.thinking)).toEqual([DROP, { type: "adaptive" }]);
    });

    it("reports a prefix mismatch as it is instead of treating it as a refusal", async () => {
        const sent: Sent[] = [];
        const session = await sessionWith(sent, {
            model: "anthropic/fable-5-2",
            // A proxy that removes the beta leaves the mismatch standing, and it names the beta.
            answer: () => invalidRequest(MISMATCH),
        });
        try {
            const events = await collect(session.run(testContext, { context: replayed }));
            expect(events.at(-1)).toMatchObject({
                type: "done",
                state: "error",
                message: expect.stringContaining("The block is bound to a different conversation"),
            });
        } finally {
            session.destroy();
        }
        expect(sent).toHaveLength(1);
        expect(isAnthropicThinkingBindingRefusal(apiError(MISMATCH))).toBe(false);
        expect(isAnthropicThinkingBindingRefusal(apiError(FIELD_REFUSED))).toBe(true);
        expect(isAnthropicThinkingBindingRefusal(apiError(FIELD_REFUSED, 500))).toBe(false);
        expect(
            isAnthropicThinkingBindingRefusal(
                apiError(
                    "Unexpected value(s) `thinking-binding-controls-2026-08-01` for the `anthropic-beta` header.",
                ),
            ),
        ).toBe(true);
        expect(isAnthropicThinkingBindingRefusal(apiError("Input is too long."))).toBe(false);
    });
});

async function sessionWith(
    sent: Sent[],
    options: {
        model: string;
        transport?: AnthropicBedrockTransport;
        /** A response to use instead of the default success. */
        answer?: (request: Sent) => Response | undefined;
    },
) {
    const transport = options.transport ?? "runtime";
    const fetch = async (url: unknown, init?: { body?: unknown }) => {
        const request = { url: String(url), body: JSON.parse(String(init?.body)) };
        sent.push(request);
        const answered = options.answer?.(request);
        if (answered !== undefined) return answered;
        const compacting = request.body.context_management?.edits?.some(
            (edit: { pause_after_compaction?: boolean }) => edit.pause_after_compaction === true,
        );
        return compacting
            ? success(
                  [{ type: "compaction", content: "Summary.", encrypted_content: "opaque" }],
                  "compaction",
              )
            : success([{ type: "text", text: "Continued." }]);
    };
    const client =
        transport === "mantle"
            ? new AnthropicBedrockMantle({
                  apiKey: "test-only-placeholder",
                  awsRegion: "us-east-1",
                  maxRetries: 0,
                  fetch,
              })
            : new AnthropicBedrock({
                  apiKey: "test-only-placeholder",
                  awsRegion: "us-east-1",
                  maxRetries: 0,
                  fetch,
              });
    const credential = await BedrockBearerTokenCredential.tryLoad({
        bearerToken: "test-only-placeholder",
    });
    if (credential === null) throw new Error("Expected a test credential.");
    const provider = new AnthropicBedrockProvider({
        client,
        credential,
        model: options.model,
        region: "us-east-1",
        transport,
        inferenceMaxRetries: 0,
    });
    return await provider.session("thinking-binding", { instructions: "", tools: [] });
}

async function collect(stream: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
}

function invalidRequest(message: string): Response {
    return new Response(
        JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }),
        { status: 400, headers: { "content-type": "application/json" } },
    );
}

function apiError(message: string, status = 400): Error {
    return new APIError(status, undefined, message, new Headers());
}

function success(blocks: readonly unknown[], stopReason = "end_turn"): Response {
    const events = [
        {
            type: "message_start",
            message: {
                id: "msg-thinking-binding",
                type: "message",
                role: "assistant",
                model: "claude-fable-5-2",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 100, output_tokens: 1 },
                // Present whenever the beta is sent; one entry per block the API dropped.
                input_transformations: [
                    {
                        type: "thinking_dropped",
                        path: "messages.1.content.0",
                        reason: "prefix_binding_mismatch",
                    },
                ],
            },
        },
        ...blocks.flatMap((content_block, index) => [
            { type: "content_block_start", index, content_block },
            { type: "content_block_stop", index },
        ]),
        {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: 10 },
        },
        { type: "message_stop" },
    ];
    return new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
    );
}
