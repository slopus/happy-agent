import type {
    SessionCompaction,
    SessionCompactionOptions,
    SessionEvent,
} from "@slopus/happy-providers";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";
import { AgentBase, type AgentBaseHooks } from "../sources/index.js";
import { providersOf, textTurn, user } from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider, ScriptedSession } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("required-compaction-test");
const required: SessionEvent[] = [
    {
        type: "done",
        state: "error",
        kind: "context_overflow",
        message: "The assembled request needs compaction.",
        providerError: {
            type: "unclassified",
            diagnostics: { code: "context_compaction_required" },
        },
    },
];
const summary = {
    role: "compaction" as const,
    content: "Retained decisions and permissions",
    encryptedContent: null,
};
const completed = (options: SessionCompactionOptions): SessionCompaction => ({
    status: "completed",
    compaction: summary,
    preservedMessages: [user("Current request")],
    usage: { input: 1_111_757, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_111_757 },
    context: {
        instructions: options.context.instructions,
        messages: [summary, user("Current request")],
    },
});

function setup(
    script: SessionEvent[][],
    compact: (
        ctx: Context,
        options: SessionCompactionOptions,
        attempt: number,
    ) => Promise<SessionCompaction>,
    retryForever = false,
) {
    const provider = new ScriptedProvider(script);
    const createSession = provider.session.bind(provider);
    provider.session = async (id, options) => {
        const session = (await createSession(id, options)) as ScriptedSession;
        session.compact = async (compactCtx, request) => {
            session.compactions.push(request);
            return await compact(compactCtx, request, session.compactions.length);
        };
        return session;
    };
    const persistence = new InMemoryPersistence();
    const changes: unknown[] = [];
    const events: SessionEvent[] = [];
    const options = {
        id: "required-compaction",
        provider: "scripted",
        model: "claude-code/default",
        providers: providersOf(provider),
        persistence,
        retryForever,
        hooks: {
            modelChanged: (_ctx, change) => {
                changes.push(change);
                return undefined;
            },
            onEvent: (_ctx, event) => {
                events.push(event);
            },
        } satisfies AgentBaseHooks,
    };
    return { provider, persistence, changes, events, options };
}

describe("assembled-request compaction owned by the outer loop", () => {
    it.each([
        "context_fixed_too_large",
        "context_compaction_no_progress",
        "context_recovery_blocked",
    ])("treats %s as terminal even under retryForever", async (code) => {
        const refusal: SessionEvent[] = [
            {
                type: "done",
                state: "error",
                kind: "internal_error",
                message: "Reduce the attached context before continuing.",
                providerError: { type: "unclassified", diagnostics: { code } },
            },
        ];
        const fixture = setup(
            [refusal, textTurn("Should not run")],
            async (_ctx, request) => completed(request),
            true,
        );
        const agent = await AgentBase.create(ctx, fixture.options);
        try {
            await agent.send(ctx, user("Current request"));
            await agent.waitForIdle();
            expect(fixture.provider.sessions[0]!.requests).toHaveLength(1);
            expect(fixture.provider.sessions[0]!.compactions).toHaveLength(0);
            expect(fixture.changes).toEqual([]);
            expect(fixture.events.at(-1)).toMatchObject({
                type: "done",
                state: "error",
                message: "Reduce the attached context before continuing.",
            });
            expect(JSON.stringify(fixture.persistence.records)).toContain("Current request");
        } finally {
            await agent.close();
        }
    });

    it("retains output before a terminal context refusal without repeating it", async () => {
        const refusal: SessionEvent[] = [
            { type: "text_start" },
            { type: "text_delta", delta: "Completed work before refusal." },
            { type: "text_end" },
            {
                type: "done",
                state: "error",
                kind: "internal_error",
                message: "Context recovery is blocked.",
                providerError: {
                    type: "unclassified",
                    diagnostics: { code: "context_recovery_blocked" },
                },
            },
        ];
        const fixture = setup(
            [refusal, textTurn("Should not run")],
            async (_ctx, request) => completed(request),
            true,
        );
        const agent = await AgentBase.create(ctx, fixture.options);
        try {
            await agent.send(ctx, user("Current request"));
            await agent.waitForIdle();
            expect(fixture.provider.sessions[0]!.requests).toHaveLength(1);
            expect(fixture.provider.sessions[0]!.compactions).toHaveLength(0);
            expect(fixture.changes).toEqual([]);
            expect(JSON.stringify(fixture.persistence.records)).toContain(
                "Completed work before refusal.",
            );
        } finally {
            await agent.close();
        }
    });

    it("routes a preflight request through one native compaction and keeps pending input", async () => {
        const fixture = setup(
            [textTurn("Old answer"), required, textTurn("Recovered")],
            async (_ctx, request) => completed(request),
        );
        const agent = await AgentBase.create(ctx, fixture.options);
        try {
            await agent.send(ctx, user("Old history"));
            await agent.waitForIdle();
            await agent.send(ctx, user("Current request"));
            await agent.waitForIdle();
            const session = fixture.provider.sessions[0]!;
            expect(session.compactions).toHaveLength(1);
            expect(session.compactions[0]!.context.messages).toEqual([
                user("Old history"),
                { role: "assistant", content: [{ type: "text", text: "Old answer" }] },
                user("Current request"),
            ]);
            expect(session.requests.at(-1)!.context.messages).toEqual([
                summary,
                user("Current request"),
            ]);
            expect(fixture.changes).toEqual([]);
            expect(fixture.persistence.records.some((record) => record.type === "compaction")).toBe(
                true,
            );
            expect(fixture.events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        } finally {
            await agent.close();
        }
    });

    it("keeps the original history and stops when native compaction fails", async () => {
        const fixture = setup([required, textTurn("Should not run")], async () => ({
            status: "failed",
            kind: "invalid_summary",
            message: "Native compaction made no useful progress.",
        }));
        const agent = await AgentBase.create(ctx, fixture.options);
        try {
            await agent.send(ctx, user("Current request"));
            await agent.waitForIdle();
            expect(fixture.provider.sessions[0]!.compactions).toHaveLength(1);
            expect(fixture.provider.sessions[0]!.requests).toHaveLength(1);
            expect(fixture.changes).toEqual([]);
            expect(fixture.persistence.records.some((record) => record.type === "compaction")).toBe(
                false,
            );
            expect(JSON.stringify(fixture.persistence.records)).toContain("Current request");
            expect(fixture.events.at(-1)).toMatchObject({
                type: "done",
                state: "error",
                message: "Native compaction made no useful progress.",
            });
        } finally {
            await agent.close();
        }
    });

    it("does not repeat deterministic failed compaction even with retryForever enabled", async () => {
        const fixture = setup(
            [required, textTurn("Should not run")],
            async (_ctx, request, attempt) =>
                attempt === 1
                    ? {
                          status: "failed",
                          kind: "invalid_summary",
                          message: "Native compaction made no useful progress.",
                      }
                    : completed(request),
            true,
        );
        const agent = await AgentBase.create(ctx, fixture.options);
        try {
            await agent.send(ctx, user("Current request"));
            await agent.waitForIdle();
            expect(fixture.provider.sessions[0]!.compactions).toHaveLength(1);
            expect(fixture.provider.sessions[0]!.requests).toHaveLength(1);
            expect(fixture.events.at(-1)).toMatchObject({ type: "done", state: "error" });
        } finally {
            await agent.close();
        }
    });

    it("does not repeat an invalid manually requested summary under retryForever", async () => {
        const fixture = setup(
            [textTurn("Existing answer")],
            async (_ctx, request, attempt) =>
                attempt === 1
                    ? {
                          status: "failed",
                          kind: "invalid_summary",
                          message: "Native compaction made no useful progress.",
                      }
                    : completed(request),
            true,
        );
        const agent = await AgentBase.create(ctx, fixture.options);
        try {
            await agent.send(ctx, user("Current request"));
            await agent.waitForIdle();
            await agent.compact(ctx);
            await agent.waitForIdle();
            expect(fixture.provider.sessions[0]!.compactions).toHaveLength(1);
            expect(fixture.persistence.records.some((record) => record.type === "compaction")).toBe(
                false,
            );
            expect(JSON.stringify(fixture.persistence.records)).toContain("Existing answer");
        } finally {
            await agent.close();
        }
    });

    it("caps a second preflight requirement without resetting or requesting compaction again", async () => {
        const fixture = setup(
            [required, required, textTurn("Should not run")],
            async (_ctx, request) => completed(request),
        );
        const agent = await AgentBase.create(ctx, fixture.options);
        try {
            await agent.send(ctx, user("Current request"));
            await agent.waitForIdle();
            expect(fixture.provider.sessions[0]!.compactions).toHaveLength(1);
            expect(fixture.provider.sessions[0]!.requests).toHaveLength(2);
            expect(fixture.changes).toEqual([]);
            expect(fixture.events.at(-1)).toMatchObject({ type: "done", state: "error" });
        } finally {
            await agent.close();
        }
    });

    it("does not continue on unchanged history when the provider cancels recovery", async () => {
        const fixture = setup([required, textTurn("Should not run")], async (_ctx, request) => ({
            status: "cancelled",
            context: request.context,
        }));
        const agent = await AgentBase.create(ctx, fixture.options);
        try {
            await agent.send(ctx, user("Current request"));
            await agent.waitForIdle();
            expect(fixture.provider.sessions[0]!.compactions).toHaveLength(1);
            expect(fixture.provider.sessions[0]!.requests).toHaveLength(1);
            expect(fixture.persistence.records.some((record) => record.type === "compaction")).toBe(
                false,
            );
            expect(fixture.events.at(-1)).toMatchObject({
                type: "done",
                state: "error",
                message: expect.stringContaining("cancelled"),
            });
        } finally {
            await agent.close();
        }
    });

    it("propagates abort into native compaction without resubmitting or resetting history", async () => {
        let started!: () => void;
        const compacting = new Promise<void>((resolve) => {
            started = resolve;
        });
        const fixture = setup(
            [required, textTurn("Should not run")],
            async (compactCtx, request) => {
                started();
                await new Promise<void>((resolve) => {
                    if (compactCtx.lifetime?.aborted) resolve();
                    else
                        compactCtx.lifetime?.addEventListener("abort", () => resolve(), {
                            once: true,
                        });
                });
                return { status: "cancelled", context: request.context };
            },
        );
        const agent = await AgentBase.create(ctx, fixture.options);
        try {
            await agent.send(ctx, user("Current request"));
            await compacting;
            await agent.abort(ctx);
            await agent.waitForIdle();
            expect(fixture.provider.sessions[0]!.compactions).toHaveLength(1);
            expect(fixture.provider.sessions[0]!.requests).toHaveLength(1);
            expect(fixture.changes).toEqual([]);
            expect(fixture.persistence.records.some((record) => record.type === "compaction")).toBe(
                false,
            );
            expect(JSON.stringify(fixture.persistence.records)).toContain("Current request");
        } finally {
            await agent.close();
        }
    });
});
