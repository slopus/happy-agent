import type { HappyAgentEvent } from "@slopus/happy-agent-client";
import { CodexProvider, type BaseProvider, type SessionEvent } from "@slopus/happy-providers";
import { expect, it, vi } from "vitest";
import { ScriptedSession } from "../support/ScriptedProvider.js";
import { credentialWriterRuntime, writerMode } from "../support/credentialWriterRuntime.js";

/**
 * Clients end every tool call still running when its run finishes. A turn's events are converted
 * on one queue per agent, and the loop can finish the whole turn while that queue is still held
 * at its first event. The run must then still be announced finished after its last tool event,
 * not by the first committed service message that finds the run already ended.
 */
it("announces a run finished after its tool events when the event queue lagged the whole turn", async () => {
    const gate = deferred();
    let gateEntered = false;
    let settled = false;
    let inferences = 0;
    const provider: BaseProvider = CodexProvider.prototype;
    vi.spyOn(provider, "session").mockImplementation(async function (id, options) {
        const session = new ScriptedSession(id, [], options);
        vi.spyOn(session, "run").mockImplementation(() =>
            (async function* () {
                if (id.startsWith("naming:")) {
                    yield done("normal");
                    return;
                }
                if (++inferences === 1) {
                    yield* text("Looking.");
                    yield { type: "block_start" } as SessionEvent;
                    yield {
                        type: "toolcall_start",
                        callId: "lagging-queue-probe",
                        name: "list_skills",
                    } as SessionEvent;
                    yield {
                        type: "toolcall_end",
                        callId: "lagging-queue-probe",
                        arguments: "{}",
                    } as SessionEvent;
                    yield { type: "block_stop" } as SessionEvent;
                    yield done("tool_call");
                    return;
                }
                yield* text("Done.");
                yield done("normal");
            })(),
        );
        return session;
    });
    const fixture = await credentialWriterRuntime("owner");
    const events = fixture.runtime.modules.events;
    const previousCursor = events.previousCursor.bind(events);
    // The accepted-message conversion and every later event of the turn share the API's
    // per-agent queue. Hold the former until the loop has settled the turn.
    const held = vi.spyOn(events, "previousCursor").mockImplementation(async (...args) => {
        if (args[1] === fixture.agent.id && !gateEntered) {
            gateEntered = true;
            await gate.promise;
        }
        return await previousCursor(...args);
    });
    const stop = events.subscribe((event) => {
        if (event.agentId === fixture.agent.id && event.type === "loop.settled") settled = true;
    });
    try {
        const before = (await fixture.owner.getEvents()).latestCursor;
        const sending = fixture.owner.sendMessage(fixture.agent.id, {
            text: "Finish while delivery is held.",
            mode: writerMode,
        });
        await vi.waitFor(() => expect(gateEntered && settled).toBe(true), {
            timeout: 10_000,
            interval: 10,
        });
        expect(inferences).toBe(2);
        gate.resolve();
        await sending;
        await vi.waitFor(
            async () => {
                expect((await fixture.owner.getAgent(fixture.agent.id)).agent.status).toBe("idle");
                const answer = (await fixture.owner.getEvents({ after: before })).events.some(
                    (event) =>
                        (event.type === "message.created" || event.type === "message.updated") &&
                        JSON.stringify(event.payload).includes("Done."),
                );
                expect(answer).toBe(true);
            },
            { timeout: 10_000, interval: 10 },
        );

        const about = (await fixture.owner.getEvents({ after: before })).events.filter(
            (event: HappyAgentEvent) =>
                (event.payload as { agentId?: string }).agentId === fixture.agent.id &&
                (event.type.startsWith("run.") || event.type.startsWith("message.")),
        );
        const types = about.map((event) => event.type);
        expect(types.filter((type) => type.startsWith("run."))).toEqual([
            "run.started",
            "run.finished",
        ]);
        // Nothing of the run follows its end.
        expect(types.at(-1)).toBe("run.finished");
        // The call had finished, in the stream, by then.
        const states = about.flatMap((event) => {
            const message = (event.payload as { message?: { content?: unknown[] } }).message;
            return (message?.content ?? []).flatMap((block) => {
                const call = block as { type?: string; name?: string; status?: string };
                return call.type === "tool_call" && call.name === "list_skills"
                    ? [call.status]
                    : [];
            });
        });
        expect(states.length).toBeGreaterThan(0);
        expect(states.at(-1)).toBe("completed");
    } finally {
        gate.resolve();
        held.mockRestore();
        stop();
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

function done(state: "normal" | "tool_call"): SessionEvent {
    return { type: "done", state, tokens: { input: 0, output: 0 } };
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
