import type { AgentModuleScope } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { HistoryModule } from "../../sources/history/HistoryModule.js";
import type { HistoryMessage } from "../../sources/history/index.js";
import { messageResource } from "../../sources/api/ApiMessageProjection.js";
import { FakeCompute } from "../compute/support/FakeCompute.js";
import { computeToolset } from "../compute/support/computeTools.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

function scopeFor(values: Map<string, unknown>): AgentModuleScope {
    return {
        agent: { id: "agent-a", provider: "codex" },
        runKV: {
            delete: async (_ctx: unknown, key: string) => {
                values.delete(key);
            },
            read: async (_ctx: unknown, key: string) => values.get(key),
            write: async (_ctx: unknown, key: string, value: unknown) => {
                values.set(key, structuredClone(value));
            },
        },
    } as never;
}

describe("History tool presentations", () => {
    it.each([false, true])(
        "retains the pre-creation identity across restart and completion (failed=%s)",
        async (failed) => {
            const history = new HistoryModule();
            const database = moduleDatabase(history.migrations, "history-spawn-presentation");
            await database.ready;
            const model = { modelId: "xai/grok-4.6", providerId: "grok", name: "Grok 4.6" };
            const presentation = { type: "agent_spawn" as const, model };
            const notices: HistoryMessage[] = [];
            const dispose = history.onToolSpawn((_ctx, _agentId, message) => {
                notices.push(message);
            });
            try {
                await history.record(database.context, "agent-a", {
                    recordId: "inference-spawn",
                    role: "assistant",
                    blocks: [
                        {
                            type: "tool_call",
                            callId: "callspawn",
                            name: "create_agent",
                            arguments: { title: "Unrelated task title" },
                        },
                    ],
                });
                await database.context.inTx(async (ctx) => {
                    await history.recordToolSpawnPresentation(
                        ctx,
                        "agent-a",
                        "callspawn",
                        presentation,
                    );
                    expect(notices).toEqual([]);
                    expect(
                        await history.toolSpawnPresentation(ctx, "agent-a", "callspawn"),
                    ).toEqual(presentation);
                });
                expect(notices).toHaveLength(1);
                await history.recordToolSpawnPresentation(
                    database.context,
                    "agent-a",
                    "callspawn",
                    presentation,
                );
                expect(notices).toHaveLength(1);
                await expect(
                    history.recordToolSpawnPresentation(database.context, "agent-a", "callspawn", {
                        ...presentation,
                        model: { ...model, name: "Changed catalog name" },
                    }),
                ).rejects.toThrow("another resolved model");

                const restarted = new HistoryModule();
                expect(
                    await restarted.toolSpawnPresentation(database.context, "agent-a", "callspawn"),
                ).toEqual(presentation);
                if (!failed)
                    await restarted.recordToolSpawnPresentation(
                        database.context,
                        "agent-a",
                        "callspawn",
                        { ...presentation, agentId: "callspawn" },
                    );
                const hooks = await resolveModuleHooks(database.context, restarted);
                const scope = scopeFor(new Map());
                await hooks.beforeToolCallTransact!(database.context, scope, {
                    type: "tool_call",
                    callId: "callspawn",
                    name: "create_agent",
                    arguments: "{}",
                });
                await hooks.afterToolCallTransact!(database.context, scope, {
                    role: "tool",
                    callId: "callspawn",
                    isError: failed,
                    content: [
                        { type: "text", text: failed ? "Spawn failed" : "Created collaborator" },
                    ],
                });
                const stored = await restarted.message(
                    database.context,
                    "agent-a",
                    "inference-spawn",
                );
                expect(stored).toBeDefined();
                expect(messageResource(stored!, { omitToolData: true }).content).toEqual([
                    {
                        type: "tool_call",
                        id: "callspawn",
                        name: "create_agent",
                        status: failed ? "failed" : "completed",
                        arguments: { title: "Unrelated task title" },
                        result: { output: failed ? "Spawn failed" : "Created collaborator" },
                        presentation: failed
                            ? presentation
                            : { ...presentation, agentId: "callspawn" },
                    },
                ]);
            } finally {
                dispose();
                database.close();
            }
        },
    );

    it("rolls back presentation state and sends no notification when the outer transaction fails", async () => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-spawn-rollback");
        await database.ready;
        const notices: HistoryMessage[] = [];
        history.onToolSpawn((_ctx, _agentId, message) => {
            notices.push(message);
        });
        try {
            await history.record(database.context, "agent-a", {
                recordId: "inference-spawn",
                role: "assistant",
                blocks: [{ type: "tool_call", callId: "callspawn", name: "create_agent" }],
            });
            await expect(
                database.context.inTx(async (ctx) => {
                    await history.recordToolSpawnPresentation(ctx, "agent-a", "callspawn", {
                        type: "agent_spawn",
                        model: { modelId: "xai/grok-4.6", providerId: "grok", name: "Grok 4.6" },
                    });
                    throw new Error("Rollback creation presentation");
                }),
            ).rejects.toThrow("Rollback creation presentation");
            expect(
                await history.toolSpawnPresentation(database.context, "agent-a", "callspawn"),
            ).toBeUndefined();
            expect(notices).toEqual([]);
        } finally {
            database.close();
        }
    });

    it("persists a compute result presentation with the completed tool call", async () => {
        const compute = new FakeCompute();
        const toolset = await computeToolset(
            createRootContext().named("history-tool-presentation-compute"),
            compute,
        );
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-tool-presentation");
        await database.ready;
        const hooks = await resolveModuleHooks(database.context, history);
        const values = new Map<string, unknown>();
        const scope = scopeFor(values);

        try {
            const write = toolset.tool("apply_patch");
            const argumentsValue = {
                patch: [
                    "*** Begin Patch",
                    "*** Add File: sources/new.ts",
                    "+export const value = 1;",
                    "*** End Patch",
                    "",
                ].join("\n"),
            };
            const result = await write.execute(database.context, argumentsValue, toolset.call);

            await history.record(database.context, "agent-a", {
                blocks: [
                    {
                        arguments: argumentsValue,
                        callId: "calledit",
                        name: "apply_patch",
                        type: "tool_call",
                    },
                ],
                recordId: "inference-edit",
                role: "assistant",
            });
            await hooks.beforeToolCallTransact!(database.context, scope, {
                arguments: JSON.stringify(argumentsValue),
                callId: "calledit",
                name: "apply_patch",
                type: "tool_call",
            });
            await hooks.afterToolCall!(database.context, scope, {
                arguments: argumentsValue,
                callId: "calledit",
                content: write.toLLM(result),
                isError: false,
                result,
                tool: write as never,
            });
            // The call-scoped KV is the handoff: a new module instance can finish recording the
            // result after a daemon restart without an in-memory presentation cache.
            const restartedHooks = await resolveModuleHooks(database.context, new HistoryModule());
            await restartedHooks.afterToolCallTransact!(database.context, scope, {
                callId: "calledit",
                content: write.toLLM(result),
                role: "tool",
            });

            const page = await history.read(database.context, "agent-a");
            expect(page.messages[0]?.message.blocks[1]).toMatchObject({
                type: "tool_result",
                presentation: {
                    type: "file_diff",
                    files: [
                        {
                            path: "sources/new.ts",
                            kind: "add",
                            added: 1,
                            deleted: 0,
                        },
                    ],
                },
            });
        } finally {
            database.close();
        }
    });
});
