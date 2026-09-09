import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";
import { expect, it } from "vitest";

import { HistoryModule } from "../../sources/history/HistoryModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

it.each([
    { name: "wide arrays", args: { items: Array.from({ length: 300 }, (_, i) => i) } },
    {
        name: "wide objects",
        args: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`key${i}`, i])),
    },
    {
        name: "deep objects",
        args: { a: { b: { c: { d: { e: { f: { g: { h: { i: true } } } } } } } } },
    },
])(
    "restricts $name only for the exact durable requested call, including after restart",
    async ({ args }) => {
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "history-requested-validation");
        await database.ready;
        const tool = defineAgentTool({
            name: "accept_json",
            parameters: Type.Unknown(),
            returnType: Type.Object({}),
            shouldReviewInAutoMode: () => false,
            execute: async () => ({}),
            toLLM: () => [],
        });
        const scope = { agent: { id: "agentvalidation" } } as never;
        try {
            await history.record(database.context, "agentvalidation", {
                at: 1,
                recordId: "requestedcall",
                role: "assistant",
                blocks: [
                    {
                        type: "tool_call",
                        callId: "requestedcall",
                        name: tool.name,
                        arguments: args,
                        requested: true,
                    },
                ],
            });
            await history.record(database.context, "agentvalidation", {
                at: 2,
                recordId: "modelinference",
                role: "assistant",
                blocks: [
                    {
                        type: "tool_call",
                        callId: "modelcall",
                        name: tool.name,
                        arguments: JSON.stringify(args),
                    },
                ],
            });
            for (const instance of [history, new HistoryModule()]) {
                const hooks = await resolveModuleHooks(database.context, instance);
                await expect(
                    Promise.resolve().then(() =>
                        hooks.beforeToolCall!(database.context, scope, {
                            callId: "requestedcall",
                            tool,
                            arguments: args,
                        }),
                    ),
                ).rejects.toThrow("Tool arguments exceed");
                await expect(
                    Promise.resolve().then(() =>
                        hooks.beforeToolCall!(database.context, scope, {
                            callId: "modelcall",
                            tool,
                            arguments: args,
                        }),
                    ),
                ).resolves.toBeUndefined();
            }
        } finally {
            database.close();
        }
    },
);
