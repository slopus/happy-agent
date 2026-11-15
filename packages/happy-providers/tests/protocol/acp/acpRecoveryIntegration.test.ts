import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { createRootContext } from "@steve.kite/stdlib";
import { expect, it } from "vitest";
import { AcpProvider } from "@/protocol/acp/AcpProvider.js";
import type { SessionContext } from "@/core/SessionContext.js";
import type { SessionEvent } from "@/core/SessionEvent.js";

it("does not retry unchanged failed compaction on Continue or a compatible account", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-durable-recovery-"));
    let prompts = 0;
    let fail = true;
    const provider = (account: string) =>
        new AcpProvider({
            stateDirectory: join(directory, account),
            recoveryDirectory: join(directory, "shared-recovery"),
            environment: () => ({ cwd: directory }),
            connect: async () => ({
                conn: {
                    newSession: async () => ({ sessionId: account }),
                    replaySession: async () => ({ sessionId: account }),
                    loadSession: async () => ({}),
                    resumeSession: async () => ({}),
                    setSessionConfigOption: async () => ({ configOptions: [] }),
                    cancel: async () => {},
                    prompt: async () => {
                        prompts++;
                        if (fail)
                            throw Object.assign(new Error("Native compaction made no progress."), {
                                code: "context_compaction_no_progress",
                            });
                        return { stopReason: "end_turn" };
                    },
                },
                init: { protocolVersion: 1 } as acp.InitializeResponse,
                exited: new Promise<Error>(() => {}),
                stderr: () => "",
                processGroups: () => [],
                terminate: () => {},
            }),
        });
    const first = await provider("account-a").session("same-agent", {
        instructions: "",
        tools: [],
    });
    const second = await provider("account-b").session("same-agent", {
        instructions: "",
        tools: [],
    });
    const context: SessionContext = {
        instructions: "Retain the workspace and permissions.",
        messages: [
            { role: "user", content: [{ type: "text", text: "Complete the original task." }] },
        ],
    };
    const original = structuredClone(context);
    const collect = async (
        session: typeof first,
        input: SessionContext,
    ): Promise<SessionEvent[]> => {
        const events: SessionEvent[] = [];
        for await (const event of session.run(createRootContext(), {
            context: input,
            model: "claude-code/default",
        }))
            events.push(event);
        return events;
    };
    try {
        expect((await collect(first, context)).at(-1)).toMatchObject({
            type: "done",
            state: "error",
        });
        expect(prompts).toBe(1);
        fail = false;
        const continued: SessionContext = {
            ...context,
            messages: [
                ...context.messages,
                {
                    role: "system",
                    content: [{ type: "text", text: "The previous request failed." }],
                },
                { role: "user", content: [{ type: "text", text: "Continue" }] },
            ],
        };
        expect((await collect(first, continued)).at(-1)).toMatchObject({
            type: "done",
            state: "error",
            message: expect.stringContaining("unchanged history"),
        });
        expect((await collect(second, continued)).at(-1)).toMatchObject({
            type: "done",
            state: "error",
            message: expect.stringContaining("unchanged history"),
        });
        expect(prompts).toBe(1);
        expect(
            (
                await collect(second, {
                    ...continued,
                    instructions: "Smaller changed instructions.",
                })
            ).at(-1),
        ).toMatchObject({ type: "done", state: "normal" });
        expect(prompts).toBe(2);
        expect(context).toEqual(original);
    } finally {
        first.destroy();
        second.destroy();
        await rm(directory, { recursive: true, force: true });
    }
});

it("signals outer compaction and records a failed explicit native summary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-outer-compaction-"));
    let prompts = 0;
    let compactions = 0;
    const provider = new AcpProvider({
        stateDirectory: join(directory, "state"),
        recoveryDirectory: join(directory, "recovery"),
        environment: () => ({ cwd: directory }),
        connect: async () => ({
            conn: {
                newSession: async () => ({ sessionId: "native" }),
                replaySession: async () => ({ sessionId: "native" }),
                loadSession: async () => ({}),
                resumeSession: async () => ({}),
                setSessionConfigOption: async () => ({ configOptions: [] }),
                cancel: async () => {},
                prompt: async () => {
                    prompts++;
                    throw Object.assign(new Error("Native context requires compaction."), {
                        code: "context_compaction_required",
                    });
                },
                compactSession: async () => {
                    compactions++;
                    return {
                        status: "failed" as const,
                        kind: "invalid_summary" as const,
                        message: "Native summary made no progress.",
                    };
                },
            },
            init: { protocolVersion: 1 } as acp.InitializeResponse,
            exited: new Promise<Error>(() => {}),
            stderr: () => "",
            processGroups: () => [],
            terminate: () => {},
        }),
    });
    const session = await provider.session("agent", { instructions: "", tools: [] });
    const context: SessionContext = {
        instructions: "Preserve all state.",
        messages: [{ role: "user", content: [{ type: "text", text: "Continue the task." }] }],
    };
    const collect = async () => {
        const events: SessionEvent[] = [];
        for await (const event of session.run(createRootContext(), { context })) events.push(event);
        return events.at(-1);
    };
    try {
        expect(await collect()).toMatchObject({
            type: "done",
            state: "error",
            kind: "context_overflow",
            providerError: { diagnostics: { code: "context_compaction_required" } },
        });
        expect(compactions).toBe(0);
        expect(await session.compact(createRootContext(), { context })).toMatchObject({
            status: "failed",
            kind: "invalid_summary",
        });
        expect(compactions).toBe(1);
        expect(await collect()).toMatchObject({
            type: "done",
            state: "error",
            kind: "internal_error",
            message: expect.stringContaining("unchanged history"),
        });
        expect(prompts).toBe(1);
    } finally {
        session.destroy();
        await rm(directory, { recursive: true, force: true });
    }
});

it.each(["context_fixed_too_large", "context_compaction_no_progress", "context_recovery_blocked"])(
    "preserves terminal %s diagnostics without unrelated stderr",
    async (code) => {
        const directory = await mkdtemp(join(tmpdir(), "acp-terminal-context-"));
        const provider = new AcpProvider({
            stateDirectory: directory,
            environment: () => ({ cwd: directory }),
            connect: async () => ({
                conn: {
                    newSession: async () => ({ sessionId: "native" }),
                    loadSession: async () => ({}),
                    resumeSession: async () => ({}),
                    setSessionConfigOption: async () => ({ configOptions: [] }),
                    cancel: async () => {},
                    prompt: async () => {
                        throw Object.assign(new Error("Safe numeric context diagnostic."), {
                            code,
                        });
                    },
                },
                init: { protocolVersion: 1 } as acp.InitializeResponse,
                exited: new Promise<Error>(() => {}),
                stderr: () => "unrelated native stderr must not be appended",
                processGroups: () => [],
                terminate: () => {},
            }),
        });
        const session = await provider.session("agent", { instructions: "", tools: [] });
        try {
            const events: SessionEvent[] = [];
            for await (const event of session.run(createRootContext(), {
                context: {
                    instructions: "",
                    messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
                },
            }))
                events.push(event);
            expect(events.at(-1)).toMatchObject({
                type: "done",
                state: "error",
                kind: "internal_error",
                message: "Safe numeric context diagnostic.",
                providerError: { type: "unclassified", diagnostics: { code } },
            });
        } finally {
            session.destroy();
            await rm(directory, { recursive: true, force: true });
        }
    },
);
