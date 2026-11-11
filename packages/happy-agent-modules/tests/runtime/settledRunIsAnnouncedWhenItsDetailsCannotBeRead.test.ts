import type { HappyAgentEvent } from "@slopus/happy-agent-client";
import { CodexProvider, type BaseProvider, type SessionEvent } from "@slopus/happy-providers";
import { expect, it, vi } from "vitest";
import { ScriptedSession } from "../support/ScriptedProvider.js";
import { credentialWriterRuntime, writerMode } from "../support/credentialWriterRuntime.js";

/**
 * A settled loop is announced from several durable reads: the run, its failure row, its usage.
 * When one of them fails, clients must still hear that the run finished and the agent is idle;
 * otherwise a client following the stream shows the agent working until something else arrives.
 */
it("announces a run finished and the agent idle when the run's usage cannot be read", async () => {
    const provider: BaseProvider = CodexProvider.prototype;
    vi.spyOn(provider, "session").mockImplementation(async function (id, options) {
        const session = new ScriptedSession(id, [], options);
        vi.spyOn(session, "run").mockImplementation(() =>
            (async function* () {
                if (!id.startsWith("naming:")) yield* text("Done.");
                yield done();
            })(),
        );
        return session;
    });
    const fixture = await credentialWriterRuntime("owner");
    const agentId = fixture.agent.id;
    const usage = fixture.runtime.modules.usage;
    const readRun = usage.readRun.bind(usage);
    let failed = false;
    vi.spyOn(usage, "readRun").mockImplementation(async (ctx, target, runId) => {
        if (target === agentId) {
            failed = true;
            throw new Error("The usage store is unavailable.");
        }
        return await readRun(ctx, target, runId);
    });
    try {
        const before = (await fixture.owner.getEvents()).latestCursor;
        const { message } = await fixture.owner.sendMessage(agentId, {
            text: "Finish this turn.",
            mode: writerMode,
        });
        await vi.waitFor(
            async () => {
                const events = (await fixture.owner.getEvents({ after: before })).events.filter(
                    (event: HappyAgentEvent) =>
                        (event.payload as { agentId?: string }).agentId === agentId,
                );
                const finished = events.findIndex(
                    (event) =>
                        event.type === "run.finished" &&
                        (event.payload as { run: { id: string } }).run.id === message.id,
                );
                expect(finished).toBeGreaterThanOrEqual(0);
                expect(events[finished]?.payload).toMatchObject({
                    run: { id: message.id, status: "completed", reason: "completed" },
                });
                const idle = events.findIndex(
                    (event, index) =>
                        index > finished &&
                        event.type === "agent.updated" &&
                        (event.payload as { changes?: { status?: string } }).changes?.status ===
                            "idle",
                );
                expect(idle).toBeGreaterThan(finished);
            },
            { timeout: 10_000, interval: 25 },
        );
        expect(failed).toBe(true);
    } finally {
        await fixture.close();
        vi.restoreAllMocks();
    }
}, 30_000);

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
