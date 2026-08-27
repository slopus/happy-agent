import type { SessionEvent } from "@slopus/happy-providers";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    AGENT_BASE_PENDING_KEY,
    AgentBase,
    type AgentBaseSettlement,
    type AgentRecord,
} from "../sources/index.js";
import { providersOf, textTurn, user } from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("happy-agent-base-settlement-failure");

/** A response the provider refuses to give, the way a usage limit arrives. */
function errorTurn(message: string): SessionEvent[] {
    return [{ type: "done", state: "error", kind: "billing_error", message }];
}

/** A store that accepts the conversation but refuses the note explaining why a turn failed. */
class UnwritableFailurePersistence extends InMemoryPersistence {
    override append(ctx: Context, record: AgentRecord): Promise<void> {
        if (record.type === "system") return Promise.reject(new Error("history is unwritable"));
        return super.append(ctx, record);
    }
}

/**
 * Every run settles, and the settlement says how the run ended.
 *
 * A run that fails is exactly the run somebody is waiting on: a collaborator's creator, a caller
 * watching the agent, an owner asking whether there is still work. Settling silently after a
 * failure leaves all of them waiting for something that is never coming, so the failure travels
 * with the settlement itself rather than only through whatever the model happened to say.
 */
describe("a failed run", () => {
    it("reopens a fatally failed run until its lifecycle succeeds when enabled", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("recovered")]);
        const settlements: AgentBaseSettlement[] = [];
        let openings = 0;
        const agent = await AgentBase.create(ctx, {
            id: "retrying-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            retryForever: true,
            hooks: {
                beforeAgentLoopTransact: () => {
                    openings += 1;
                    if (openings === 1) throw new Error("the run could not be opened");
                },
                afterAgentSettledTransact: (_hookCtx, settlement) => {
                    settlements.push(settlement);
                },
            },
        });

        await agent.send(ctx, user("do the work"));
        await agent.waitForIdle();

        expect(openings).toBe(2);
        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect(settlements).toHaveLength(1);
        expect(settlements[0]?.error).toBeUndefined();
        expect(agent.active).toBe(false);
        await agent.close();
    });

    it("settles with the provider failure that ended it", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([errorTurn("You have reached your usage limit.")]);
        const settlements: AgentBaseSettlement[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "failing-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                afterAgentSettledTransact: (_hookCtx, settlement) => {
                    settlements.push(settlement);
                },
            },
        });

        await agent.send(ctx, user("do the work"));
        await agent.waitForIdle();

        expect(settlements).toHaveLength(1);
        expect(settlements[0]?.error).toBe("You have reached your usage limit.");
        expect(persistence.values.has(AGENT_BASE_PENDING_KEY)).toBe(false);
        expect(agent.active).toBe(false);
        await agent.close();
    });

    it("settles when the run ends by throwing rather than by answering", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("never asked")]);
        const settlements: AgentBaseSettlement[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "throwing-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                beforeAgentLoopTransact: () => {
                    throw new Error("the run could not be opened");
                },
                afterAgentSettledTransact: (_hookCtx, settlement) => {
                    settlements.push(settlement);
                },
            },
        });

        await agent.send(ctx, user("do the work"));
        await agent.waitForIdle();

        // Without settling, this agent would be recorded as working for ever: the loop is over,
        // no process is going to reopen it, and nothing would ever say why.
        expect(settlements).toHaveLength(1);
        expect(settlements[0]?.error).toBe("the run could not be opened");
        expect(persistence.values.has(AGENT_BASE_PENDING_KEY)).toBe(false);
        expect(agent.active).toBe(false);
        await agent.close();
    });

    it("settles with the failure even when the conversation could not record it", async () => {
        const persistence = new UnwritableFailurePersistence();
        const provider = new ScriptedProvider([errorTurn("upstream fell over")]);
        const settlements: AgentBaseSettlement[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "unrecordable-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                afterAgentSettledTransact: (_hookCtx, settlement) => {
                    settlements.push(settlement);
                },
            },
        });

        // The system message describing the failure cannot be written, so the settlement is the
        // only place the failure exists at all.
        await agent.send(ctx, user("do the work"));
        await agent.waitForIdle();

        expect(settlements[0]?.error).toBe("upstream fell over");
        await agent.close();
    });

    it("says nothing about a failure the run went on to recover from", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            errorTurn("a momentary provider hiccup"),
            textTurn("here is the answer"),
        ]);
        const settlements: AgentBaseSettlement[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "recovering-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                afterAgentSettledTransact: (_hookCtx, settlement) => {
                    settlements.push(settlement);
                },
            },
        });

        await agent.send(ctx, user("first"));
        await agent.waitForIdle();
        await agent.send(ctx, user("second"));
        await agent.waitForIdle();

        expect(settlements).toHaveLength(2);
        expect(settlements[0]?.error).toBe("a momentary provider hiccup");
        // The turn that answered is the run's ending, not the one before it that failed.
        expect(settlements[1]?.error).toBeUndefined();
        await agent.close();
    });

    it("settles a run that simply ran out of work without any failure", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("all done")]);
        const settlements: AgentBaseSettlement[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "quiet-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                afterAgentSettledTransact: (_hookCtx, settlement) => {
                    settlements.push(settlement);
                },
            },
        });

        await agent.send(ctx, user("do the work"));
        await agent.waitForIdle();

        expect(settlements).toHaveLength(1);
        expect(settlements[0]?.error).toBeUndefined();
        await agent.close();
    });
});
