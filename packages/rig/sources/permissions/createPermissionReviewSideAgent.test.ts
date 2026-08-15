import { describe, expect, it } from "vitest";

import {
    defineModel,
    defineProvider,
    type Context,
    type Model,
    type Provider,
    type StreamOptions,
} from "@slopus/rig-execution";
import { Agent } from "../agent/Agent.js";
import type { Message } from "../agent/types.js";
import { createJustBashToolHarness } from "../testing/createAgentTestHarness.js";
import { createPermissionContext } from "./createPermissionContext.js";
import { createPermissionReviewSideAgent } from "./createPermissionReviewSideAgent.js";
import { createTestRootContext } from "../testing/createTestRootContext.js";

const ctx = createTestRootContext();

describe("createPermissionReviewSideAgent", () => {
    it("runs a dedicated reviewer model without exposing it as a selectable model", async () => {
        const recorded = recordingProvider();
        const reviewerModel = defineModel({
            id: "openai/codex-auto-review",
            name: "Codex Auto Review",
            thinkingLevels: ["low"],
            defaultThinkingLevel: "low",
        });
        const requestedModels: string[] = [];
        const provider = {
            ...recorded.provider,
            reviewerModel,
            stream<TThinkingLevel extends string>(
                runtimeCtx: Parameters<Provider["stream"]>[0],
                model: Model<TThinkingLevel>,
                context: Context,
                options?: StreamOptions<TThinkingLevel>,
            ) {
                requestedModels.push(model.id);
                return recorded.provider.stream(runtimeCtx, model, context, options);
            },
        };

        expect(provider.models.map((model) => model.id)).not.toContain(reviewerModel.id);
        expect(
            () =>
                new Agent({
                    context: createJustBashToolHarness().context,
                    modelId: reviewerModel.id,
                    provider,
                    tools: [],
                }),
        ).toThrow(`Unknown model '${reviewerModel.id}'`);
        const reviewer = sideAgent(provider, reviewerModel as never);
        await reviewer.review(ctx, { action: "review this", messages: [user("u1", "AUTHORIZED")] });

        expect(requestedModels).toEqual([reviewerModel.id]);
        await reviewer.close();
    });

    it("uses and closes an isolated provider without closing the session provider", async () => {
        const parent = recordingProvider();
        const isolated = recordingProvider();
        let parentCloseCount = 0;
        let isolatedCloseCount = 0;
        const isolatedProvider = {
            ...isolated.provider,
            close() {
                isolatedCloseCount += 1;
            },
        };
        const provider = {
            ...parent.provider,
            close() {
                parentCloseCount += 1;
            },
            isolate(label: string) {
                expect(label).toBe("auto-reviewer");
                return isolatedProvider;
            },
        };
        const reviewer = sideAgent(provider, parent.model);

        await reviewer.review(ctx, { action: "review this", messages: [user("u1", "AUTHORIZED")] });
        await reviewer.close();

        expect(parent.requests).toHaveLength(0);
        expect(isolated.requests).toHaveLength(1);
        expect(parentCloseCount).toBe(0);
        expect(isolatedCloseCount).toBe(1);
    });

    it("sends only new conversation once it already has its own history", async () => {
        const { provider, model, requests } = recordingProvider();
        const reviewer = sideAgent(provider, model);

        await reviewer.review(ctx, { action: "first action", messages: [user("u1", "ALPHA")] });
        await reviewer.review(ctx, {
            action: "second action",
            messages: [user("u1", "ALPHA"), user("u2", "BRAVO")],
        });

        const second = JSON.stringify(requests[1]?.messages.at(-1)?.content ?? "");
        expect(second).toContain("BRAVO");
        // ALPHA is already in the reviewer's own history; repeating it would nest every earlier
        // review's context inside the next one.
        expect(second).not.toContain("ALPHA");
        expect(second).toContain("second action");
        await reviewer.close();
    });

    it("serializes parallel reviews through its stateful model conversation", async () => {
        const firstStarted = deferred<void>();
        const releaseFirst = deferred<void>();
        const recorded = recordingProvider({
            waitOnCall: { call: 1, release: releaseFirst.promise, started: firstStarted.resolve },
        });
        const reviewer = sideAgent(recorded.provider, recorded.model);

        const first = reviewer.review(ctx, {
            action: "first parallel action",
            messages: [user("u1", "Run the requested release checks.")],
        });
        await firstStarted.promise;
        const second = reviewer.review(ctx, {
            action: "second parallel action",
            messages: [user("u1", "Run the requested release checks.")],
        });
        await Promise.resolve();
        releaseFirst.resolve();

        await Promise.all([first, second]);
        expect(recorded.maxActiveStreams()).toBe(1);
        await reviewer.close();
    });

    it("forgets pre-reset authorization and sends a new prohibition as fresh evidence", async () => {
        const { provider, model, requests } = recordingProvider();
        const reviewer = sideAgent(provider, model);

        await reviewer.review(ctx, {
            action: "first action",
            messages: [user("u1", "AUTHORIZED")],
        });
        await reviewer.reset();
        const result = await reviewer.review(ctx, {
            action: "second action",
            messages: [user("u2", "PROHIBITED")],
        });

        expect(JSON.stringify(requests[1]?.messages)).toContain("PROHIBITED");
        expect(JSON.parse(result.text)).toMatchObject({ outcome: "deny" });
        await reviewer.close();
    });

    it("starts over when a review is cut short, so it never stacks two unanswered questions", async () => {
        const { provider, model, requests } = recordingProvider({ cutShortOnCall: 1 });
        const reviewer = sideAgent(provider, model);

        await reviewer
            .review(ctx, { action: "first action", messages: [user("u1", "ALPHA")] })
            .catch(() => undefined);

        await reviewer.review(ctx, {
            action: "second action",
            messages: [user("u1", "ALPHA"), user("u2", "BRAVO")],
        });

        const second = requests[1]?.messages ?? [];
        expect(second.filter((message) => message.role === "user")).toHaveLength(1);
        // Starting over means the reviewer has no history, so it needs the conversation again.
        expect(JSON.stringify(second.at(-1)?.content)).toContain("ALPHA");
        await reviewer.close();
    });

    it("refuses to review while it is itself in Auto mode", () => {
        const { provider, model } = recordingProvider();
        const harness = createJustBashToolHarness();
        harness.context.permissions = createPermissionContext("auto");

        expect(() =>
            createPermissionReviewSideAgent({
                context: harness.context,
                id: "auto-reviewer",
                model,
                provider,
                tools: [],
            }),
        ).toThrow("must not run in Auto mode");
    });

    it("reads the project instructions, so a project-defined request is not ambiguous to it", async () => {
        const { provider, model, requests } = recordingProvider();
        const reviewer = sideAgent(provider, model, {
            "/workspace/AGENTS.md": "When the user says `sync to main`, push directly to `main`.",
        });

        await reviewer.review(ctx, {
            action: "git push origin HEAD:main",
            messages: [user("u1", "Sync to main")],
        });

        // AGENTS.md is context the reviewer reads to understand what the user asked for. It is
        // still never authorization on its own; the user's message is what authorizes.
        expect(JSON.stringify(requests[0]?.messages)).toContain("push directly to `main`");
        await reviewer.close();
    });

    it("reads the latest global security policy before every review", async () => {
        const { provider, model, requests } = recordingProvider();
        let securityPolicy = "FIRST SECURITY POLICY";
        const harness = createJustBashToolHarness();
        harness.context.permissions = createPermissionContext("read_only");
        const reviewer = createPermissionReviewSideAgent({
            context: harness.context,
            id: "auto-reviewer",
            model,
            provider,
            readSecurityPolicy: () => Promise.resolve(securityPolicy),
            tools: [],
        });

        await reviewer.review(ctx, { action: "first", messages: [user("u1", "ALPHA")] });
        securityPolicy = "SECOND SECURITY POLICY";
        await reviewer.review(ctx, {
            action: "second",
            messages: [user("u1", "ALPHA"), user("u2", "BRAVO")],
        });

        expect(systemPromptOf(requests[0])).toContain("FIRST SECURITY POLICY");
        expect(systemPromptOf(requests[1])).toContain("SECOND SECURITY POLICY");
        expect(systemPromptOf(requests[1])).not.toContain("FIRST SECURITY POLICY");
        await reviewer.close();
    });

    it("reports what each review did and cost, without re-reporting earlier reviews", async () => {
        const { provider, model } = recordingProvider();
        const reviewer = sideAgent(provider, model);

        const first = await reviewer.review(ctx, {
            action: "first",
            messages: [user("u1", "ALPHA")],
        });
        expect(first.transcript?.usage.totalTokens).toBe(15);
        expect(first.transcript?.modelId).toBe("openai/gpt-test");
        expect(first.transcript?.providerId).toBe("codex");
        expect(first.transcript?.entries.map((entry) => entry.type)).toEqual(["text"]);

        // The reviewer keeps its history, so a second review must bill only its own inference.
        const second = await reviewer.review(ctx, {
            action: "second",
            messages: [user("u1", "ALPHA"), user("u2", "BRAVO")],
        });
        expect(second.transcript?.usage.totalTokens).toBe(15);
        await reviewer.close();
    });

    it("reports omitted user evidence from the whole conversation, not just the delta", async () => {
        const { provider, model } = recordingProvider();
        const reviewer = sideAgent(provider, model);
        const oversized = Array.from({ length: 7 }, (_, index) =>
            user(`u${String(index)}`, `EVIDENCE_${String(index)} ${"e".repeat(10_000)}`),
        );

        await reviewer.review(ctx, { action: "first", messages: oversized });
        const second = await reviewer.review(ctx, {
            action: "second",
            messages: [...oversized, user("late", "one more")],
        });

        expect(second.userEvidenceOmitted).toBe(true);
        await reviewer.close();
    });
});

function sideAgent(
    provider: ReturnType<typeof recordingProvider>["provider"],
    model: never,
    files?: Record<string, string>,
) {
    const harness = createJustBashToolHarness(files === undefined ? {} : { files });
    harness.context.permissions = createPermissionContext("read_only");
    return createPermissionReviewSideAgent({
        context: harness.context,
        id: "auto-reviewer",
        model,
        provider,
        tools: [],
    });
}

function user(id: string, text: string): Message {
    return { role: "user", id, blocks: [{ type: "text", text }] };
}

function systemPromptOf(context: Context | undefined): string {
    return context?.systemPromptOverride ?? context?.systemPrompt ?? "";
}

function recordingProvider(
    options: {
        cutShortOnCall?: number;
        waitOnCall?: { call: number; release: Promise<void>; started: () => void };
    } = {},
) {
    const model = defineModel({
        id: "openai/gpt-test",
        name: "GPT Test",
        thinkingLevels: ["off"],
        defaultThinkingLevel: "off",
    });
    const requests: Context[] = [];
    let activeStreams = 0;
    let maxActiveStreams = 0;
    const provider = defineProvider({
        id: "codex",
        models: [model],
        stream(_ctx, _model, context) {
            requests.push(context);
            const call = requests.length;
            const denied = JSON.stringify(context.messages).includes("PROHIBITED");
            const message = {
                api: "test",
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify({
                            outcome: denied ? "deny" : "allow",
                            risk_level: denied ? "high" : "low",
                            user_authorization: denied ? "low" : "high",
                            rationale: denied ? "The user prohibited this action." : "Routine.",
                        }),
                    },
                ],
                model: model.id,
                provider: "codex",
                role: "assistant" as const,
                stopReason: (call === options.cutShortOnCall ? "aborted" : "stop") as
                    | "aborted"
                    | "stop",
                timestamp: 1,
                usage: {
                    cacheRead: 0,
                    cacheWrite: 0,
                    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 1, total: 1 },
                    input: 10,
                    output: 5,
                    totalTokens: 15,
                },
            };
            return {
                async *[Symbol.asyncIterator]() {
                    activeStreams += 1;
                    maxActiveStreams = Math.max(maxActiveStreams, activeStreams);
                    try {
                        if (call === options.waitOnCall?.call) {
                            options.waitOnCall.started();
                            await options.waitOnCall.release;
                        }
                        if (call === options.cutShortOnCall) {
                            yield {
                                error: message,
                                reason: "aborted" as const,
                                type: "error" as const,
                            };
                            return;
                        }
                        yield { message, reason: "stop" as const, type: "done" as const };
                    } finally {
                        activeStreams -= 1;
                    }
                },
                async result() {
                    return message;
                },
            };
        },
    });
    return { maxActiveStreams: () => maxActiveStreams, model: model as never, provider, requests };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void } {
    let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: (value) => resolvePromise(value as T) };
}
