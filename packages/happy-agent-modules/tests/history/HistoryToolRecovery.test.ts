import { Type } from "@sinclair/typebox";
import {
    AGENT_BASE_PENDING_KEY,
    Agent,
    type AgentDatabase,
    AgentKV,
    AgentStorage,
    defineAgentTool,
} from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";

import { HistoryModule } from "../../sources/history/HistoryModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { providersOf, textTurn } from "../support/fixtures.js";
import { resolveModuleRuntime } from "../support/moduleHooks.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

describe("History tool recovery", () => {
    it("settles a reconstructed call without reusing its interrupted inference identity", async () => {
        const database = moduleDatabase([], "history-interrupted-inference-recovery");
        await database.ready;
        const history = new HistoryModule();
        const storage = new AgentStorage<AgentDatabase>({
            acquireLock: () => Promise.resolve({ release: () => Promise.resolve() }),
            database: database.database,
        });
        await storage.migrate(database.context, [history]);

        const agentId = "agenttoolrecovery";
        const callId = "callrecoveredtool";
        const inferenceId = "inferencerecoveredtool";
        const persistence = storage.persistence(agentId);
        const agentKV = new AgentKV(persistence, `kv.${agentId}.`);
        const historyRunKV = agentKV.scoped("run", "module", history.name);

        await persistence.transaction(database.context, async (ctx) => {
            await persistence.append(ctx, {
                type: "block",
                id: callId,
                block: {
                    type: "tool_call",
                    arguments: "{}",
                    callId: "provider-recovered-tool",
                    name: "fragile_tool",
                },
            });
            await persistence.writeValue(ctx, AGENT_BASE_PENDING_KEY, {
                stage: "inference",
                loopId: "looprecoveredtool",
                turnId: "turnrecoveredtool",
                inferenceId,
            });
            await historyRunKV.write(ctx, "pending_blocks", [
                {
                    type: "tool_call",
                    arguments: {},
                    callId,
                    name: "fragile_tool",
                },
            ]);
            await historyRunKV.write(ctx, "pending_inference_id", inferenceId);
        });

        let executions = 0;
        const fragileTool = defineAgentTool({
            name: "fragile_tool",
            returnType: Type.Object({}),
            shouldReviewInAutoMode: () => false,
            execute: () => {
                executions += 1;
                return Promise.resolve({});
            },
            toLLM: () => [],
        });
        const provider = new ScriptedProvider([textTurn("recovered")]);
        const agent = await Agent.load(database.context, {
            id: agentId,
            initialState: { tools: [fragileTool] },
            modules: [await resolveModuleRuntime(database.context, history)],
            persistence,
            provider: "scripted",
            providers: providersOf(provider),
            sharedKV: storage.kv,
        });

        try {
            expect(agent.active).toBe(true);
            agent.start();
            await agent.waitForIdle();

            expect(executions).toBe(1);
            expect(agent.active).toBe(false);
            expect(await persistence.readValues(database.context, "tool.")).toEqual([]);
            expect(await persistence.readValues(database.context, AGENT_BASE_PENDING_KEY)).toEqual(
                [],
            );

            const page = await history.read(database.context, agentId);
            expect(page.messages).toHaveLength(2);
            expect(page.messages[0]?.message).toMatchObject({
                recordId: inferenceId,
                role: "assistant",
                blocks: [
                    { callId, type: "tool_call" },
                    { callId, type: "tool_result" },
                ],
            });
            expect(page.messages[1]?.message).toMatchObject({
                role: "assistant",
                blocks: [{ text: "recovered", type: "text" }],
            });
            expect(page.messages[1]?.message.recordId).not.toBe(inferenceId);
        } finally {
            await agent.close();
            database.close();
        }
    });
});
