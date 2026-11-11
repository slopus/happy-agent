import { AsyncResource } from "node:async_hooks";
import { createId } from "@paralleldrive/cuid2";
import type { HappyAgentEvent } from "@slopus/happy-agent-client";
import { CodexProvider, type BaseProvider, type SessionEvent } from "@slopus/happy-providers";
import { expect, it, vi } from "vitest";
// Base keeps its persistence class private to the package. The test observes, and never changes,
// the one write that records a run's settle decision, to land a steer in the window after it.
import { AgentPersistenceDrizzle } from "../../node_modules/@slopus/happy-agent-base/dist/AgentPersistenceDrizzle.js";
import { USER_MESSAGE_ORIGIN_METADATA } from "../../sources/impl/messageOrigin.js";
import { ScriptedSession } from "../support/ScriptedProvider.js";
import { credentialWriterRuntime, writerMode } from "../support/credentialWriterRuntime.js";

/**
 * A person's steer that commits after a run decided to settle, but before the settlement itself,
 * keeps that run open so the steer can end it as `aborted/steering`. Stopping the agent before the
 * reopened turn accepts the steer cancels that turn. The open run must still end, the agent must
 * read idle in every snapshot, and the stopped steer stays queued for the person.
 */
it("ends the run a late steer kept open when the agent is stopped before accepting it", async () => {
    let inferences = 0;
    let armed = false;
    let steering: Promise<unknown> | undefined;
    const provider: BaseProvider = CodexProvider.prototype;
    vi.spyOn(provider, "session").mockImplementation(async function (id, options) {
        const session = new ScriptedSession(id, [], options);
        vi.spyOn(session, "run").mockImplementation(() =>
            (async function* () {
                if (id.startsWith("naming:")) {
                    yield done();
                    return;
                }
                inferences += 1;
                yield* text(inferences === 1 ? "Done." : "Steered.");
                if (inferences === 1) armed = true;
                yield done();
            })(),
        );
        return session;
    });
    const fixture = await credentialWriterRuntime("owner");
    const agentId = fixture.agent.id;
    const history = fixture.runtime.modules.history;
    const steerId = createId();
    // The steer and the Stop are the person's own requests, not part of the work they race.
    const outside = new AsyncResource("test.person");
    const write = AgentPersistenceDrizzle.prototype.writeValue;
    const settling = vi
        .spyOn(AgentPersistenceDrizzle.prototype, "writeValue")
        .mockImplementation(async function (this: AgentPersistenceDrizzle, ctx, key, value) {
            await write.call(this, ctx, key, value);
            if (!armed || key !== "owed" || (value as { stage?: string }).stage !== "settlement")
                return;
            armed = false;
            // Queued now, this transaction commits after the settle decision and before the
            // settlement, exactly as a person's steer racing the end of the turn does.
            steering = outside.runInAsyncScope(() =>
                fixture.ctx.inTx(async (txCtx) => {
                    await history.queuePending(txCtx, {
                        id: steerId,
                        agentId,
                        role: "user",
                        status: "pending",
                        delivery: "steer",
                        createdAt: Date.now(),
                        blocks: [{ type: "text", text: "Also check the tests." }],
                        mode: writerMode,
                        profile: null,
                        runId: null,
                    });
                    await fixture.runtime.system.steer(
                        txCtx,
                        agentId,
                        {
                            role: "user",
                            content: [{ type: "text", text: "Also check the tests." }],
                        },
                        {
                            id: steerId,
                            provider: writerMode.providerId,
                            model: writerMode.modelId,
                            effort: "medium",
                            serviceTier: null,
                            permissionMode: writerMode.permissionMode,
                            metadata: { ...USER_MESSAGE_ORIGIN_METADATA, mode: writerMode },
                        },
                    );
                }),
            );
        });
    // The person presses Stop once the steer is in, while the turn that would accept it is
    // still starting up.
    let firstSettled = false;
    let stopping: Promise<void> | undefined;
    const settled: string[] = [];
    const stop = fixture.runtime.modules.events.subscribe((event) => {
        if (event.agentId !== agentId || event.type !== "loop.settled") return;
        firstSettled = true;
        settled.push(event.id);
    });
    const slashCommands = fixture.runtime.modules.slashCommands;
    const refresh = slashCommands.refresh.bind(slashCommands);
    vi.spyOn(slashCommands, "refresh").mockImplementation(async (ctx, target) => {
        if (target === agentId && firstSettled && stopping === undefined) {
            stopping = outside.runInAsyncScope(async () => {
                await steering;
                await fixture.runtime.modules.abort.abort(fixture.ctx, agentId);
            });
            await stopping;
        }
        return await refresh(ctx, target);
    });
    try {
        const before = (await fixture.owner.getEvents()).latestCursor;
        const { message } = await fixture.owner.sendMessage(agentId, {
            text: "Finish this turn.",
            mode: writerMode,
        });
        const firstRunId = message.id;
        await vi.waitFor(() => expect(stopping).toBeDefined(), { timeout: 10_000, interval: 10 });
        await stopping;
        expect(settling).toHaveBeenCalled();
        // The stopped turn settles too.
        await vi.waitFor(() => expect(settled.length).toBe(2), { timeout: 10_000, interval: 10 });

        // The steer was cancelled before any turn accepted it, so no second inference ran, and
        // it stays queued for the person, as after any abort.
        expect(inferences).toBe(1);
        expect((await history.pending(fixture.ctx, agentId)).map((pending) => pending.id)).toEqual([
            steerId,
        ]);
        await vi.waitFor(
            async () => {
                expect((await fixture.owner.getAgent(agentId)).agent.status).toBe("idle");
            },
            { timeout: 10_000, interval: 25 },
        );
        expect(await history.runningRun(fixture.ctx, agentId)).toBeUndefined();
        expect(await history.run(fixture.ctx, agentId, firstRunId)).toMatchObject({
            status: "aborted",
            reason: "abort",
        });
        // A client following the stream is told the run ended.
        await vi.waitFor(
            async () => {
                const finished = (await fixture.owner.getEvents({ after: before })).events.filter(
                    (event: HappyAgentEvent) =>
                        event.type === "run.finished" &&
                        (event.payload as { run: { id: string } }).run.id === firstRunId,
                );
                expect(finished).toHaveLength(1);
            },
            { timeout: 10_000, interval: 25 },
        );
        // Stop is still accepted, and the agent stays idle.
        await fixture.owner.abortAgent(agentId);
        expect((await fixture.owner.getAgent(agentId)).agent.status).toBe("idle");
    } finally {
        stop();
        settling.mockRestore();
        await fixture.close();
        vi.restoreAllMocks();
    }
}, 60_000);

function* text(value: string): Generator<SessionEvent> {
    yield { type: "block_start" };
    yield { type: "text_start" };
    yield { type: "text_delta", delta: value };
    yield { type: "text_end" };
    yield { type: "block_stop" };
}

function done(): SessionEvent {
    return { type: "done", state: "normal", tokens: { input: 0, output: 0 } };
}
