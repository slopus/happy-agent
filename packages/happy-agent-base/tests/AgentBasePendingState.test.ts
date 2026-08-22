import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    AgentBase,
    agentBasePendingStateOf,
    agentBaseStoreOwesWork,
    AGENT_BASE_PENDING_KEY,
} from "../sources/index.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";
import { providersOf, textTurn, user, userRecord } from "./gym/fixtures.js";

const ctx = createRootContext().named("happy-agent-base-pending-state");
const LOOP_ID = "l12345678901234567890123";
const TURN_ID = "t12345678901234567890123";
const INFERENCE_ID = "i12345678901234567890123";
const SETTLEMENT_ID = "s12345678901234567890123";

interface Deferred {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
}

function deferred(): Deferred {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

/**
 * The agent records what it still owes, and erases that record on its way out. The record is the
 * whole of the active flag: what it says while a run is under way is how a later process finds
 * work nobody finished, and its absence is what "settled" means.
 */
describe("durable pending state", () => {
    it("is the only durable fact that makes an agent active", async () => {
        const persistence = new InMemoryPersistence([userRecord("completed empty response")]);

        expect(await agentBaseStoreOwesWork(ctx, persistence)).toBe(false);

        persistence.values.set(AGENT_BASE_PENDING_KEY, {
            stage: "inference",
            loopId: LOOP_ID,
        });
        expect(await agentBaseStoreOwesWork(ctx, persistence)).toBe(true);
    });

    it("records outstanding work while running and erases it once settled", async () => {
        const persistence = new InMemoryPersistence();
        const stages: (string | undefined)[] = [];
        const provider = new ScriptedProvider([textTurn("answer")]);
        const agent = await AgentBase.create(ctx, {
            id: "records-pending",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                beforeInference: async (hookCtx: Context) => {
                    const pending = await agentBasePendingStateOf(hookCtx, persistence);
                    stages.push(pending?.stage);
                },
            },
        });

        expect(agent.active).toBe(false);
        await agent.send(ctx, user("question"));
        await agent.waitForIdle();

        // While the model was being asked, the store said so; once the run ended, the record is
        // gone and nothing is left claiming the agent has work.
        expect(stages).toEqual(["inference"]);
        expect(await agentBasePendingStateOf(ctx, persistence)).toBeUndefined();
        expect(persistence.values.has(AGENT_BASE_PENDING_KEY)).toBe(false);
        expect(agent.active).toBe(false);
        await agent.close();
    });

    it("reports itself active only while it has work left", async () => {
        const persistence = new InMemoryPersistence();
        const releaseInference = deferred();
        const inferenceStarted = deferred();
        const provider = new ScriptedProvider([textTurn("answer")]);
        const agent = await AgentBase.create(ctx, {
            id: "active-getter",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                beforeInference: async () => {
                    inferenceStarted.resolve();
                    await releaseInference.promise;
                },
            },
        });

        await agent.send(ctx, user("question"));
        await inferenceStarted.promise;
        const activeWhileWorking = agent.active;
        releaseInference.resolve();
        await agent.waitForIdle();

        expect({ activeWhileWorking, activeAfter: agent.active }).toEqual({
            activeWhileWorking: true,
            activeAfter: false,
        });
        await agent.close();
    });

    it("leaves the work it was doing on record when the process never settles", async () => {
        const persistence = new InMemoryPersistence();
        const inferenceStarted = deferred();
        const releaseInference = deferred();
        const provider = new ScriptedProvider([textTurn("answer")]);
        const abandoned = await AgentBase.create(ctx, {
            id: "abandoned",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                beforeInference: async () => {
                    inferenceStarted.resolve();
                    await releaseInference.promise;
                },
            },
        });

        await abandoned.send(ctx, user("question"));
        await inferenceStarted.promise;

        // A process that dies here writes nothing further. What it already committed is the
        // consumed message and the stage it had reached, and both are discoverable by an owner
        // that has never seen this run.
        expect(await agentBasePendingStateOf(ctx, persistence)).toMatchObject({
            stage: "inference",
        });
        expect(await agentBaseStoreOwesWork(ctx, persistence)).toBe(true);

        releaseInference.resolve();
        await abandoned.waitForIdle();
        await abandoned.close();
        expect(await agentBaseStoreOwesWork(ctx, persistence)).toBe(false);
    });

    it("tells a listener to drop a block that a cut-off run will never finish", async () => {
        const persistence = new InMemoryPersistence([userRecord("interrupted question")]);
        persistence.values.set(AGENT_BASE_PENDING_KEY, {
            stage: "inference",
            loopId: LOOP_ID,
        });
        const events: string[] = [];
        const provider = new ScriptedProvider([textTurn("recovered")]);
        const restarted = await AgentBase.create(ctx, {
            id: "restarted",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: { onEvent: (_hookCtx, event) => events.push(event.type) },
        });

        restarted.start();
        await restarted.waitForIdle();

        // The half-streamed block was never persisted, so the conversation is intact — it is the
        // view that was shown a beginning without an end, and it is told to drop it before the
        // resumed response starts producing blocks of its own.
        expect(events[0]).toBe("block_reset");
        expect(await agentBaseStoreOwesWork(ctx, persistence)).toBe(false);
        await restarted.close();
    });

    it("commits what a settling hook writes together with the settlement itself", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("answer")]);
        const agent = await AgentBase.create(ctx, {
            id: "settles-transactionally",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                afterAgentSettledTransact: async (hookCtx: Context) => {
                    // The agent is still recorded as working from inside the transaction: the
                    // erasure is staged here and becomes visible only when this commits.
                    await persistence.writeValue(hookCtx, "conclusion", {
                        owedAtWriteTime: await agentBasePendingStateOf(hookCtx, persistence),
                    });
                },
            },
        });

        await agent.send(ctx, user("question"));
        await agent.waitForIdle();

        expect(persistence.values.get("conclusion")).toEqual({ owedAtWriteTime: undefined });
        expect(persistence.values.has(AGENT_BASE_PENDING_KEY)).toBe(false);
        await agent.close();
    });

    it("keeps the agent recorded as working when the settling hook fails", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("answer")]);
        const agent = await AgentBase.create(ctx, {
            id: "settle-rolls-back",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                afterAgentSettledTransact: async (hookCtx: Context) => {
                    await persistence.writeValue(hookCtx, "conclusion", "written");
                    throw new Error("the settling hook failed");
                },
            },
        });

        await agent.send(ctx, user("question"));
        await agent.waitForIdle();

        // A conclusion that failed to be written must not be reported as one that was, so the
        // whole settlement unwinds: the hook's write is gone and the agent still says it owes
        // work, which costs one wasted resumption and never a lost answer.
        expect(persistence.values.has("conclusion")).toBe(false);
        expect(await agentBasePendingStateOf(ctx, persistence)).toMatchObject({
            stage: "settlement",
        });
        expect(agent.active).toBe(true);
        await agent.close();
    });

    it("reuses persisted loop, turn, and inference identities after restart", async () => {
        const persistence = new InMemoryPersistence([userRecord("resume")]);
        persistence.values.set(AGENT_BASE_PENDING_KEY, {
            stage: "inference",
            loopId: LOOP_ID,
            turnId: TURN_ID,
            inferenceId: INFERENCE_ID,
        });
        const observed: unknown[] = [];
        const restarted = await AgentBase.load(ctx, {
            id: "identity-restart",
            providers: providersOf(new ScriptedProvider([textTurn("done")])),
            provider: "scripted",
            persistence,
            hooks: {
                beforeInferenceTransact: (_hookCtx, inference) => void observed.push(inference),
                beforeInference: (_hookCtx, inference) => void observed.push(inference),
                afterInferenceTransact: (_hookCtx, inference) => void observed.push(inference),
                afterInference: (_hookCtx, inference) => void observed.push(inference),
            },
        });

        restarted.start();
        await restarted.waitForIdle();

        expect(observed).toHaveLength(4);
        expect(observed).toMatchObject(
            Array.from({ length: 4 }, () => ({
                loopId: LOOP_ID,
                turnId: TURN_ID,
                inferenceId: INFERENCE_ID,
            })),
        );
        await restarted.close();
    });

    it("resumes a durable settlement directly with its original identity", async () => {
        const persistence = new InMemoryPersistence();
        persistence.values.set(AGENT_BASE_PENDING_KEY, {
            stage: "settlement",
            loopId: LOOP_ID,
            settlementId: SETTLEMENT_ID,
        });
        const settlements: unknown[] = [];
        const provider = new ScriptedProvider([]);
        const restarted = await AgentBase.load(ctx, {
            id: "settlement-restart",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                afterAgentSettledTransact: (_hookCtx, settlement) =>
                    void settlements.push(settlement),
                afterAgentSettled: (_hookCtx, settlement) => void settlements.push(settlement),
            },
        });

        restarted.start();
        await restarted.waitForIdle();

        expect(settlements).toEqual([
            { loopId: LOOP_ID, settlementId: SETTLEMENT_ID },
            { loopId: LOOP_ID, settlementId: SETTLEMENT_ID },
        ]);
        expect(provider.sessions).toHaveLength(0);
        expect(await agentBasePendingStateOf(ctx, persistence)).toBeUndefined();
        await restarted.close();
    });
});
