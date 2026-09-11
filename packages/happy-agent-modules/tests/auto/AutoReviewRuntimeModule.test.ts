import type {
    AgentBaseInference,
    AgentBasePersistedEvent,
    AgentBaseToolOutcome,
    AgentModuleAgent,
    AgentModuleScope,
} from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { PERMISSION_REVIEW_INSTRUCTIONS } from "../../sources/auto/impl/createPermissionReviewInstructions.js";
import { AutoReviewRuntimeModule } from "../../sources/auto/impl/AutoReviewRuntimeModule.js";

const context: Context = createRootContext().named("auto-review-runtime-test");

function scope(id = "reviewer"): AgentModuleScope {
    const agent: AgentModuleAgent = {
        id,
        metadata: undefined,
        model: "openai/codex-auto-review",
        provider: "codex",
        providerKind: "codex",
        effort: "low",
        permissionMode: "read_only",
        tier: undefined,
    };
    return { agent } as AgentModuleScope;
}

function persistedEvent(event: unknown): AgentBasePersistedEvent {
    return event as AgentBasePersistedEvent;
}

describe("AutoReviewRuntimeModule", () => {
    it("retains provider errors and clears them before the next inference", () => {
        const module = new AutoReviewRuntimeModule();
        const hooks = module.beforeStart();
        module.beginReview("reviewer", "instructions");
        hooks.onEvent?.(context, scope(), {
            type: "done",
            state: "error",
            kind: "unknown",
            message: "404: model does not exist",
        });
        expect(module.takeCapture("reviewer").errorMessage).toBe("404: model does not exist");
        expect(module.takeCapture("reviewer").errorMessage).toBeUndefined();
    });

    it("does not reuse a previous inference's done event for an unfinished continuation", () => {
        const module = new AutoReviewRuntimeModule();
        const hooks = module.beforeStart();
        module.beginReview("reviewer", "instructions");
        hooks.onEvent?.(context, scope(), {
            type: "done",
            state: "normal",
            tokens: { input: 1, output: 1 },
        });
        hooks.beforeInference?.(context, scope(), {} as never);
        hooks.afterInference?.(context, scope(), { state: undefined } as AgentBaseInference);
        expect(module.takeCapture("reviewer")).toMatchObject({
            doneState: undefined,
            inferenceStarted: true,
        });
    });

    it("uses the bundled instructions until a review overrides them", () => {
        const module = new AutoReviewRuntimeModule();
        const hooks = module.beforeStart();

        expect(hooks?.instructions?.(context, scope())).toBe(PERMISSION_REVIEW_INSTRUCTIONS);

        module.beginReview("reviewer", "fresh review instructions");

        expect(hooks?.instructions?.(context, scope())).toBe("fresh review instructions");
    });

    it("captures reasoning, text, tool calls, tool results, usage, and completion state", () => {
        const module = new AutoReviewRuntimeModule();
        const hooks = module.beforeStart();
        const reviewerScope = scope();
        module.beginReview("reviewer", "instructions");

        hooks?.onEventTransact?.(
            context,
            reviewerScope,
            persistedEvent({
                type: "reasoning_end",
                block: { type: "thinking", text: "I should inspect the target." },
            }),
        );
        hooks?.onEventTransact?.(
            context,
            reviewerScope,
            persistedEvent({
                type: "text_end",
                block: { type: "text", text: "<review><outcome>allow</outcome></review>" },
            }),
        );
        hooks?.onEventTransact?.(
            context,
            reviewerScope,
            persistedEvent({
                type: "toolcall_end",
                block: {
                    type: "tool_call",
                    callId: "call-1",
                    name: "read_file",
                    arguments: '{"path":"README.md"}',
                },
            }),
        );
        hooks?.afterToolCall?.(context, reviewerScope, {
            callId: "call-1",
            tool: { namespace: "codex", name: "read_file" },
            arguments: { path: "README.md" },
            content: [
                { type: "text", text: "first line" },
                { type: "image", data: "opaque", mimeType: "image/png" },
            ],
            isError: false,
        } as unknown as AgentBaseToolOutcome);
        hooks?.onEvent?.(context, reviewerScope, {
            type: "token_usage",
            usage: {
                input: 3,
                output: 4,
                cacheRead: 5,
                cacheWrite: 6,
                totalTokens: 18,
            },
        });
        hooks?.onEvent?.(context, reviewerScope, {
            type: "token_usage",
            usage: {
                input: 1,
                output: 2,
                cacheRead: 3,
                cacheWrite: 4,
                totalTokens: 10,
            },
        });
        hooks?.onEvent?.(context, reviewerScope, {
            type: "done",
            state: "normal",
            tokens: { input: 4, output: 6 },
        });

        expect(module.takeCapture("reviewer")).toEqual({
            entries: [
                { type: "thinking", text: "I should inspect the target." },
                { type: "text", text: "<review><outcome>allow</outcome></review>" },
                {
                    type: "tool_call",
                    name: "read_file",
                    arguments: '{"path":"README.md"}',
                },
                {
                    type: "tool_result",
                    name: "codex/read_file",
                    isError: false,
                    text: "first line\n[image]",
                },
            ],
            usage: {
                input: 4,
                output: 6,
                cacheRead: 8,
                cacheWrite: 10,
                totalTokens: 28,
            },
            inferred: true,
            doneState: "normal",
        });
    });

    it("marks a review as inferred when a done event has no token-usage event", () => {
        const module = new AutoReviewRuntimeModule();
        const hooks = module.beforeStart();
        const reviewerScope = scope();
        module.beginReview("reviewer", "instructions");

        hooks?.onEvent?.(context, reviewerScope, {
            type: "done",
            state: "error",
            kind: "unknown",
            message: "failed",
        } as never);
        expect(module.takeCapture("reviewer")).toMatchObject({
            inferred: false,
            doneState: "error",
        });

        hooks?.afterInference?.(context, reviewerScope, {
            state: "error",
            tokens: undefined,
            errorMessage: "failed",
        } as unknown as AgentBaseInference);
        expect(module.takeCapture("reviewer")).toMatchObject({
            inferred: true,
            doneState: "error",
        });
    });

    it("returns an empty capture for an unknown reviewer", () => {
        const module = new AutoReviewRuntimeModule();

        expect(module.takeCapture("missing")).toEqual({
            entries: [],
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
            },
            inferred: false,
            doneState: undefined,
        });
    });

    it("takes and clears a review capture so a repeated read cannot duplicate it", () => {
        const module = new AutoReviewRuntimeModule();
        const hooks = module.beforeStart();
        module.beginReview("reviewer", "instructions");
        hooks?.onEventTransact?.(
            context,
            scope(),
            persistedEvent({
                type: "text_end",
                block: { type: "text", text: "verdict" },
            }),
        );

        expect(module.takeCapture("reviewer").entries).toEqual([{ type: "text", text: "verdict" }]);
        expect(module.takeCapture("reviewer")).toEqual({
            entries: [],
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
            },
            inferred: false,
            doneState: undefined,
        });
    });
});
