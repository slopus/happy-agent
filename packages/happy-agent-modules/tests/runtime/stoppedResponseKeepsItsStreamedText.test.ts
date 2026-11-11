import { CodexProvider, type BaseProvider, type SessionEvent } from "@slopus/happy-providers";
import { expect, it, vi } from "vitest";
import { ScriptedSession } from "../support/ScriptedProvider.js";
import { credentialWriterRuntime, writerMode } from "../support/credentialWriterRuntime.js";

/**
 * A person who presses Stop while the agent is still writing has already read what it wrote.
 * The text streamed before the stop stays in the aborted run's history, so it is still there
 * after a reload, a reconnect, or a restart.
 */
it("keeps the text a stopped response had already streamed", async () => {
    const streamed = deferred();
    const provider: BaseProvider = CodexProvider.prototype;
    vi.spyOn(provider, "session").mockImplementation(async function (id, options) {
        const session = new ScriptedSession(id, [], options);
        vi.spyOn(session, "run").mockImplementation((ctx) =>
            (async function* () {
                if (id.startsWith("naming:")) {
                    yield done();
                    return;
                }
                yield* text("A finished paragraph.");
                yield { type: "block_start" } as SessionEvent;
                yield { type: "text_start" } as SessionEvent;
                yield { type: "text_delta", delta: "Still going, " } as SessionEvent;
                yield { type: "text_delta", delta: "halfway through" } as SessionEvent;
                streamed.resolve();
                // The provider keeps the response open until the stop reaches it.
                await new Promise<void>((resolve) => {
                    if (ctx.lifetime?.aborted === true) resolve();
                    ctx.lifetime?.addEventListener("abort", () => resolve(), { once: true });
                });
                yield { type: "done", state: "cancelled" } as SessionEvent;
            })(),
        );
        return session;
    });
    const fixture = await credentialWriterRuntime("owner");
    const agentId = fixture.agent.id;
    try {
        const { message } = await fixture.owner.sendMessage(agentId, {
            text: "Write something long.",
            mode: writerMode,
        });
        await streamed.promise;
        await fixture.owner.abortAgent(agentId);
        await vi.waitFor(
            async () => {
                expect((await fixture.owner.getAgent(agentId)).agent.status).toBe("idle");
            },
            { timeout: 10_000, interval: 25 },
        );
        const expectStoppedText = async () => {
            const page = await fixture.owner.getMessages(agentId);
            const run = page.runs.find((candidate) => candidate.id === message.id);
            expect(run).toMatchObject({ status: "aborted", reason: "abort" });
            const agentText = (run?.messages ?? [])
                .filter((entry) => entry.role === "agent")
                .flatMap((entry) => entry.content)
                .flatMap((block) => (block.type === "text" ? [block.text] : []));
            expect(agentText).toEqual(["A finished paragraph.", "Still going, halfway through"]);
        };
        await vi.waitFor(expectStoppedText, { timeout: 10_000, interval: 25 });
        await fixture.restart();
        await expectStoppedText();
    } finally {
        streamed.resolve();
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

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
