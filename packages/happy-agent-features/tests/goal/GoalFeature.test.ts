import { Agent, AgentSystemLocal } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import type { SessionEvent } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    GoalFeature as BaseGoalFeature,
    goalWakeStateSchema,
    type GoalFeatureOptions,
    type GoalWakeScheduler,
    type GoalWakeState,
} from "../../sources/index.js";
import { ScriptedProvider, type ScriptedSession } from "../support/ScriptedProvider.js";
import { providersOf, sharedKV, textTurn, toolCallTurn, user } from "../support/fixtures.js";
import { agentWorld } from "../support/agentWorld.js";
import { goalStorage } from "./goalTestStorage.js";

const ctx = createRootContext().named("happy-agent-features-goal");
const afterCommit = (_ctx: typeof ctx, callback: (postCommitCtx: typeof ctx) => unknown): void => {
    void callback(ctx);
};
function defaultWakeScheduler(): GoalWakeScheduler {
    const states = new Map<string, GoalWakeState>();
    return {
        read: (_ctx, agentId) => Promise.resolve(structuredClone(states.get(agentId))),
        reconcile: (_ctx, state) => {
            states.set(state.agentId, structuredClone(state));
            return Promise.resolve();
        },
    };
}

class GoalFeature extends BaseGoalFeature {
    constructor(options: GoalFeatureOptions) {
        super(
            options.wakeScheduler === undefined
                ? { ...options, wakeScheduler: defaultWakeScheduler() }
                : options,
        );
    }
}

/** Durable latest-state fake whose pending schedule can be recovered by a fresh host instance. */
class RecoverableGoalWakeScheduler implements GoalWakeScheduler {
    readonly #store: (
        agentId: string,
    ) => ReturnType<ReturnType<typeof agentWorld>["stores"]["get"]>;

    constructor(
        store: (agentId: string) => ReturnType<ReturnType<typeof agentWorld>["stores"]["get"]>,
    ) {
        this.#store = store;
    }

    async reconcile(reconcileCtx: typeof ctx, state: GoalWakeState): Promise<void> {
        const store = this.#requiredStore(state.agentId);
        const key = this.#key(state.agentId);
        await store.writeValue(reconcileCtx, key, structuredClone(state));
        const persisted = await this.read(reconcileCtx, state.agentId);
        if (persisted === undefined) throw new Error("Goal wake state was not retained.");
    }

    async recover(
        recoverCtx: typeof ctx,
        agentId: string,
        deliver: (state: Extract<GoalWakeState, { state: "scheduled" }>) => Promise<void>,
    ): Promise<void> {
        const state = await this.read(recoverCtx, agentId);
        if (state?.state === "scheduled") await deliver(state);
    }

    async read(readCtx: typeof ctx, agentId: string): Promise<GoalWakeState | undefined> {
        const key = this.#key(agentId);
        const entry = (await this.#requiredStore(agentId).readValues(readCtx, key)).find(
            (candidate) => candidate.key === key,
        );
        if (entry === undefined) return undefined;
        if (!Value.Check(goalWakeStateSchema, entry.value)) {
            throw new Error("Goal wake state is malformed.");
        }
        return structuredClone(entry.value) as GoalWakeState;
    }

    #requiredStore(agentId: string) {
        const store = this.#store(agentId);
        if (store === undefined) throw new Error("Goal agent store does not exist.");
        return store;
    }

    #key(agentId: string): string {
        return `goal-wake.${agentId}`;
    }
}

/** Every text the model was sent, across every inference of a run. */
function requestedTexts(session: ScriptedSession): string[] {
    return session.requests.flatMap((request) =>
        request.context.messages.flatMap((message) =>
            message.role === "user"
                ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
                : [],
        ),
    );
}

/** One agent of a collection, running that collection's goal feature. */
async function goalAgent(agentId: string, script: SessionEvent[][]) {
    const world = agentWorld();
    const provider = new ScriptedProvider(script);
    const goals = new GoalFeature({ afterCommit, storage: goalStorage(world.storage) });
    const agent = await Agent.create(ctx, {
        id: agentId,
        providers: providersOf(provider),
        provider: "scripted",
        persistence: world.storage.persistence(agentId),
        sharedKV: sharedKV(),
        features: [goals],
    });
    return { agent, goals, provider, world };
}

describe("GoalFeature", () => {
    it("keeps the agent working while the goal is active, and lets it stop once it is complete", async () => {
        const { agent, goals, provider, world } = await goalAgent("goal-agent", [
            toolCallTurn("call-1", "create_goal", JSON.stringify({ objective: "ship the thing" })),
            textTurn("goal started"),
            toolCallTurn("call-2", "update_goal", JSON.stringify({ status: "complete" })),
            textTurn("all done"),
        ]);

        await agent.send(ctx, user("start a goal"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        const session = provider.sessions[0];
        if (session === undefined) throw new Error("The agent never opened a session.");
        // Four inferences: the tool call and its follow-up in the first turn, then the same
        // again in the turn the feature itself asked for.
        expect(session.requests).toHaveLength(4);
        expect(requestedTexts(session).join("\n")).toContain(
            "Continue working toward the active goal.",
        );
        // What the model's tools wrote is what an outside caller reads: one store, one goal.
        expect(await goals.goal(ctx, "goal-agent")).toEqual({
            createdAt: expect.any(Number),
            objective: "ship the thing",
            status: "complete",
            updatedAt: expect.any(Number),
        });
        const store = world.stores.get("goal-agent");
        if (store === undefined) throw new Error("Missing Goal agent store.");
        expect(
            [...store.values.keys()].some(
                (key) => key.includes(".call.") && key.endsWith(".feature.goal.operation"),
            ),
        ).toBe(false);
    });

    it("lets an agent with no goal settle after one turn", async () => {
        const { agent, goals, provider } = await goalAgent("goalless-agent", [
            textTurn("answered"),
        ]);

        await agent.send(ctx, user("just answer"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect(await goals.goal(ctx, "goalless-agent")).toBeUndefined();
    });

    it("stops asking for another turn once the model reports the goal blocked", async () => {
        const { agent, goals, provider } = await goalAgent("blocked-agent", [
            toolCallTurn("call-1", "create_goal", JSON.stringify({ objective: "ship the thing" })),
            textTurn("goal started"),
            toolCallTurn("call-2", "update_goal", JSON.stringify({ status: "blocked" })),
            textTurn("I need the credentials"),
        ]);

        await agent.send(ctx, user("start a goal"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        expect(provider.sessions[0]?.requests).toHaveLength(4);
        expect((await goals.goal(ctx, "blocked-agent"))?.status).toBe("blocked");
    });

    it("works toward a goal set from outside before the agent ever ran", async () => {
        const { agent, goals, provider } = await goalAgent("api-goal-agent", [
            textTurn("answered the question"),
            toolCallTurn("call-1", "update_goal", JSON.stringify({ status: "complete" })),
            textTurn("done"),
        ]);

        await goals.setGoal(ctx, "api-goal-agent", "ship the thing");
        await agent.send(ctx, user("go"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        const session = provider.sessions[0];
        if (session === undefined) throw new Error("The agent never opened a session.");
        expect(requestedTexts(session).join("\n")).toContain("ship the thing");
        expect((await goals.goal(ctx, "api-goal-agent"))?.status).toBe("complete");
    });

    it("does not continue a goal an outside caller paused", async () => {
        const { agent, goals, provider } = await goalAgent("paused-agent", [textTurn("answered")]);
        await goals.setGoal(ctx, "paused-agent", "ship the thing");
        await goals.changeGoalStatus(ctx, "paused-agent", "paused");

        await agent.send(ctx, user("anything else?"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        // A paused goal asks for nothing, so the agent answers once and settles.
        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect((await goals.goal(ctx, "paused-agent"))?.status).toBe("paused");
    });

    it("recovers a durable external wake after a scheduler restart", async () => {
        const world = agentWorld();
        const provider = new ScriptedProvider([
            toolCallTurn("call-1", "update_goal", JSON.stringify({ status: "complete" })),
            textTurn("done"),
        ]);
        const wakeScheduler = new RecoverableGoalWakeScheduler((agentId) =>
            world.stores.get(agentId),
        );
        const goals = new GoalFeature({
            afterCommit,
            storage: goalStorage(world.storage),
            wakeScheduler,
        });
        const system = await AgentSystemLocal.create(ctx, world.storage, {
            features: [goals],
            providers: providersOf(provider),
            provider: "scripted",
            models: [],
        });
        const agent = await system.create(ctx, {});

        // Nothing has been said to this agent. The feature commits only a durable schedule.
        await goals.setGoal(ctx, agent.id, "ship the thing");
        const restartedScheduler = new RecoverableGoalWakeScheduler((agentId) =>
            world.stores.get(agentId),
        );
        await restartedScheduler.recover(ctx, agent.id, async (request) => {
            await system.send(
                ctx,
                request.agentId,
                {
                    role: "user",
                    content: [{ type: "text", text: request.prompt }],
                },
                { id: request.messageId, await: true },
            );
        });
        await agent.waitForIdle();
        await expect(
            restartedScheduler.recover(ctx, agent.id, () =>
                Promise.reject(new Error("cancelled wake was delivered")),
            ),
        ).resolves.toBeUndefined();
        await agent.close();

        const session = provider.sessions[0];
        if (session === undefined) throw new Error("The goal never started the agent.");
        expect(requestedTexts(session).join("\n")).toContain("ship the thing");
        expect((await goals.goal(ctx, agent.id))?.status).toBe("complete");
    });

    it("rejects a changed external activation without a scheduler before durable mutation", async () => {
        const world = agentWorld();
        let factoryCalls = 0;
        const events: unknown[] = [];
        const goals = new BaseGoalFeature({
            afterCommit,
            idFactory: () => {
                factoryCalls += 1;
                return "must-not-allocate";
            },
            listener: {
                onEventTransactional: (_eventCtx, event) => {
                    events.push(event);
                },
            },
            storage: goalStorage(world.storage),
        });

        await expect(
            goals.setGoal(ctx, "scheduler-required-agent", "ship the thing"),
        ).rejects.toThrow("requires a durable wake scheduler");
        await expect(goals.goal(ctx, "scheduler-required-agent")).resolves.toBeUndefined();
        expect(factoryCalls).toBe(1);
        expect(events).toEqual([]);
        expect(world.stores.get("scheduler-required-agent")?.values.size).toBe(0);
    });

    it("keeps self-created goals moving through the normal loop without a scheduler", async () => {
        const world = agentWorld();
        const provider = new ScriptedProvider([
            toolCallTurn("call-1", "create_goal", JSON.stringify({ objective: "ship the thing" })),
            textTurn("started"),
            toolCallTurn("call-2", "update_goal", JSON.stringify({ status: "complete" })),
            textTurn("done"),
        ]);
        const goals = new BaseGoalFeature({
            afterCommit,
            storage: goalStorage(world.storage),
        });
        const agent = await Agent.create(ctx, {
            id: "self-goal-no-scheduler",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: world.storage.persistence("self-goal-no-scheduler"),
            sharedKV: sharedKV(),
            features: [goals],
        });

        await agent.send(ctx, user("start a goal"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        expect(provider.sessions[0]?.requests).toHaveLength(4);
        expect((await goals.goal(ctx, agent.id))?.status).toBe("complete");
    });

    it("stops driving the agent after a failed turn, and gives up after three", async () => {
        const failedTurn: SessionEvent[] = [
            {
                type: "done",
                state: "error",
                kind: "internal_error",
                message: "the provider is down",
            },
        ];
        const { agent, goals, provider } = await goalAgent("failing-agent", [
            failedTurn,
            failedTurn,
            failedTurn,
        ]);
        await goals.setGoal(ctx, "failing-agent", "ship the thing");

        for (let attempt = 0; attempt < 3; attempt += 1) {
            await agent.send(ctx, user("keep going"), { await: true });
            await agent.waitForIdle();
        }
        await agent.close();

        // Each failed turn ends the work rather than asking for another, so the only turns that
        // ran are the three the messages asked for.
        expect(provider.sessions[0]?.requests).toHaveLength(3);
        expect((await goals.goal(ctx, "failing-agent"))?.status).toBe("blocked");
    });

    it("allocates a fresh automatic block identity for a second goal lifecycle", async () => {
        const failedTurn: SessionEvent[] = [
            {
                type: "done",
                state: "error",
                kind: "internal_error",
                message: "the provider is down",
            },
        ];
        const { agent, goals } = await goalAgent("reused-agent", [
            failedTurn,
            failedTurn,
            failedTurn,
            failedTurn,
            failedTurn,
            failedTurn,
        ]);

        await goals.setGoal(ctx, "reused-agent", "ship the first thing");
        for (let attempt = 0; attempt < 3; attempt += 1) {
            await agent.send(ctx, user("keep going"), { await: true });
            await agent.waitForIdle();
        }
        expect((await goals.goal(ctx, "reused-agent"))?.status).toBe("blocked");

        await goals.clearGoal(ctx, "reused-agent", { operationId: "clear-first-goal" });
        await goals.setGoal(ctx, "reused-agent", "ship the second thing", {
            operationId: "set-second-goal",
        });
        await agent.send(ctx, user("keep going"), { await: true });
        await agent.waitForIdle();
        expect((await goals.goal(ctx, "reused-agent"))?.status).toBe("active");
        for (let attempt = 1; attempt < 3; attempt += 1) {
            await agent.send(ctx, user("keep going"), { await: true });
            await agent.waitForIdle();
        }

        expect((await goals.goal(ctx, "reused-agent"))?.status).toBe("blocked");
        await agent.close();
    });

    it("offers the three goal tools to the model", async () => {
        const { agent, provider } = await goalAgent("tools-agent", [textTurn("answered")]);

        await agent.send(ctx, user("hello"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        expect(provider.sessions[0]?.options.tools?.map((tool) => tool.name)).toEqual([
            "create_goal",
            "get_goal",
            "update_goal",
            "clear_goal",
        ]);
    });
});
