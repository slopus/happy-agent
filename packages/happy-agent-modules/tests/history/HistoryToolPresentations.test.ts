import type { AgentModuleScope } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { HistoryModule } from "../../sources/history/HistoryModule.js";
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

            await hooks.beforeToolCallTransact!(database.context, scope, {
                arguments: JSON.stringify(argumentsValue),
                callId: "call-edit",
                name: "apply_patch",
                type: "tool_call",
            });
            await hooks.afterToolCall!(database.context, scope, {
                arguments: argumentsValue,
                callId: "call-edit",
                content: write.toLLM(result),
                isError: false,
                result,
                tool: write as never,
            });
            // The call-scoped KV is the handoff: a new module instance can finish recording the
            // result after a daemon restart without an in-memory presentation cache.
            const restartedHooks = await resolveModuleHooks(database.context, new HistoryModule());
            await restartedHooks.afterToolCallTransact!(database.context, scope, {
                callId: "call-edit",
                content: write.toLLM(result),
                role: "tool",
            });

            const page = await history.read(database.context, "agent-a");
            expect(page.messages[0]?.message.blocks[0]).toMatchObject({
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
