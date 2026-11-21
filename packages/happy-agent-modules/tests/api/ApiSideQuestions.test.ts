import { EventEmitter } from "node:events";
import {
    createServer,
    request as httpRequest,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, expect, it, vi } from "vitest";

import { ApiError } from "../../sources/api/ApiError.js";
import { ApiSideQuestions, type ApiSideQuestionState } from "../../sources/api/ApiSideQuestions.js";

const servers: Server[] = [];
afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
        servers.splice(0).map(
            (server) =>
                new Promise<void>((resolve) => {
                    server.closeAllConnections();
                    server.close(() => resolve());
                }),
        ),
    );
});

/**
 * An answer that comes only when `resolve` or `reject` is called, and notes its abort. Stopped,
 * it gives up, as a harness does.
 */
function pendingAnswer() {
    let resolve!: (answer: { response: string | null; synthetic: boolean }) => void;
    let reject!: (error: unknown) => void;
    const state = { signal: undefined as AbortSignal | undefined };
    const answer = (signal: AbortSignal) => {
        state.signal = signal;
        return new Promise<{ response: string | null; synthetic: boolean }>((ok, fail) => {
            resolve = ok;
            reject = fail;
            signal.addEventListener("abort", () => fail(new Error("Stopped.")), { once: true });
        });
    };
    return {
        answer,
        state,
        resolve: (text: string) => resolve({ response: text, synthetic: false }),
        reject: (error: unknown) => reject(error),
    };
}

/** Hands `sideQuestion` to a request as a response that was sent in full. */
function sendInFull(
    questions: ApiSideQuestions,
    agentId: string,
    owner: string | undefined,
    sideQuestion: ApiSideQuestionState,
): void {
    const response = Object.assign(new EventEmitter(), { writableFinished: false });
    questions.deliver(response, agentId, owner, sideQuestion, () => response.emit("finish"));
}

/** A local HTTP server whose requests `handle` answers; its port. */
async function serve(
    handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): Promise<number> {
    const server = createServer((request, response) => {
        void handle(request, response);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
}

/** A request to `port`: its whole response once it arrives, and a way to drop its connection. */
function call(port: number, method: "POST" | "GET") {
    const request = httpRequest({ host: "127.0.0.1", port, method });
    // A dropped connection is the point of some tests, not a failure.
    request.on("error", () => undefined);
    const response = new Promise<{ status: number; body: string }>((resolve) => {
        request.on("response", (incoming) => {
            let body = "";
            incoming.setEncoding("utf8");
            incoming.on("data", (chunk: string) => (body += chunk));
            incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body }));
        });
    });
    request.end();
    return { response, drop: () => request.destroy() };
}

it("answers at once when the answer comes within the wait, and keeps it until it is collected", async () => {
    const questions = new ApiSideQuestions({ waitMs: 1_000 });

    const state = await questions.ask("agent-1", undefined, async () => ({
        response: "The parser.",
        synthetic: false,
    }));

    expect(state).toEqual({
        id: expect.any(String),
        status: "answered",
        response: "The parser.",
        synthetic: false,
    });
    // The response carrying it may never arrive, so the next request gets the answer again.
    expect(await questions.wait("agent-1", undefined, state.id)).toEqual(state);
    // Someone else's collecting changes nothing.
    sendInFull(questions, "agent-1", "user-2", state);
    sendInFull(questions, "agent-2", undefined, state);
    expect(await questions.wait("agent-1", undefined, state.id)).toEqual(state);

    sendInFull(questions, "agent-1", undefined, state);
    expect(await questions.wait("agent-1", undefined, state.id)).toBeUndefined();
});

it("reports a question still being answered, and hands its answer to the next wait", async () => {
    const questions = new ApiSideQuestions({ waitMs: 20 });
    const pending = pendingAnswer();

    const first = await questions.ask("agent-1", undefined, pending.answer);
    expect(first).toEqual({ id: expect.any(String), status: "answering" });
    expect(await questions.wait("agent-1", undefined, first.id)).toEqual({
        id: first.id,
        status: "answering",
    });

    const waiting = questions.wait("agent-1", undefined, first.id);
    pending.resolve("Halfway.");
    expect(await waiting).toEqual({
        id: first.id,
        status: "answered",
        response: "Halfway.",
        synthetic: false,
    });
    expect(pending.state.signal?.aborted).toBe(false);
});

it("reports a harness failure as a failed question, and refuses with the error it was refused with", async () => {
    const questions = new ApiSideQuestions({ waitMs: 1_000 });

    const failed = await questions.ask("agent-1", undefined, async () => {
        throw new Error("Rate limited until 3 pm.");
    });
    expect(failed).toEqual({
        id: expect.any(String),
        status: "failed",
        error: "Rate limited until 3 pm.",
    });
    expect(await questions.wait("agent-1", undefined, failed.id)).toEqual(failed);
    sendInFull(questions, "agent-1", undefined, failed);
    expect(await questions.wait("agent-1", undefined, failed.id)).toBeUndefined();

    const refusal = new ApiError(409, "harness_not_running", "There is no conversation yet.");
    await expect(
        questions.ask("agent-1", undefined, async () => {
            throw refusal;
        }),
    ).rejects.toBe(refusal);
});

it("stops answering a cancelled question and forgets it", async () => {
    const questions = new ApiSideQuestions({ waitMs: 10 });
    const pending = pendingAnswer();
    const { id } = await questions.ask("agent-1", undefined, pending.answer);

    expect(questions.cancel("agent-1", undefined, id)).toBe(true);
    expect(pending.state.signal?.aborted).toBe(true);
    expect(questions.cancel("agent-1", undefined, id)).toBe(false);
    expect(await questions.wait("agent-1", undefined, id)).toBeUndefined();
    // An answer arriving after all goes nowhere.
    pending.resolve("Too late.");
});

it("ends a wait with nothing when its question is cancelled meanwhile", async () => {
    const questions = new ApiSideQuestions({ waitMs: 20 });
    const pending = pendingAnswer();
    const { id } = await questions.ask("agent-1", undefined, pending.answer);

    const waiting = questions.wait("agent-1", undefined, id);
    questions.cancel("agent-1", undefined, id);

    // Not "answering": a client polling on would never be answered.
    expect(await waiting).toBeUndefined();
});

it("keeps a question to the agent and the person who asked it", async () => {
    const questions = new ApiSideQuestions({ waitMs: 10 });
    const pending = pendingAnswer();
    const { id } = await questions.ask("agent-1", "user-1", pending.answer);

    expect(await questions.wait("agent-2", "user-1", id)).toBeUndefined();
    expect(await questions.wait("agent-1", "user-2", id)).toBeUndefined();
    expect(await questions.wait("agent-1", undefined, id)).toBeUndefined();
    expect(questions.cancel("agent-1", "user-2", id)).toBe(false);
    expect(pending.state.signal?.aborted).toBe(false);
    expect(await questions.wait("agent-1", "user-1", id)).toEqual({ id, status: "answering" });
});

it("stops and forgets a question nobody collects within ten minutes", async () => {
    vi.useFakeTimers();
    const questions = new ApiSideQuestions({ waitMs: 1_000 });
    const pending = pendingAnswer();
    const asking = questions.ask("agent-1", undefined, pending.answer);
    await vi.advanceTimersByTimeAsync(1_000);
    const { id } = await asking;

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(pending.state.signal?.aborted).toBe(true);
    expect(await questions.wait("agent-1", undefined, id)).toBeUndefined();
});

it("stops a question at once when its asker leaves before learning its id", async () => {
    const questions = new ApiSideQuestions({ waitMs: 60_000 });
    const pending = pendingAnswer();
    const port = await serve(async (_request, response) => {
        const sideQuestion = await questions.ask("agent-1", undefined, pending.answer, response);
        questions.deliver(response, "agent-1", undefined, sideQuestion, () =>
            response.end(JSON.stringify(sideQuestion)),
        );
    });

    const asking = call(port, "POST");
    await vi.waitFor(() => expect(pending.state.signal).toBeDefined());
    asking.drop();

    // At once, not after the 60 seconds the request would wait.
    await vi.waitFor(() => expect(pending.state.signal?.aborted).toBe(true));
});

it("keeps an answer whose response lost its connection for the next request, and forgets it once one arrives", async () => {
    const questions = new ApiSideQuestions({ waitMs: 2_000 });
    const pending = pendingAnswer();
    const { id } = await questions.ask("agent-1", undefined, pending.answer);
    const waits: ApiSideQuestionState["status"][] = [];
    let waiting = 0;
    let closed = 0;
    const port = await serve(async (_request, response) => {
        response.once("close", () => (closed += response.writableFinished ? 0 : 1));
        waiting++;
        const sideQuestion = await questions.wait("agent-1", undefined, id);
        if (sideQuestion === undefined) {
            response.writeHead(404).end();
            return;
        }
        waits.push(sideQuestion.status);
        questions.deliver(response, "agent-1", undefined, sideQuestion, () =>
            response.end(JSON.stringify(sideQuestion)),
        );
    });

    // The connection drops while the request waits; then the answer comes.
    const lost = call(port, "GET");
    await vi.waitFor(() => expect(waiting).toBe(1), { interval: 5 });
    lost.drop();
    await vi.waitFor(() => expect(closed).toBe(1), { interval: 5 });
    pending.resolve("The parser.");
    await vi.waitFor(() => expect(waits).toEqual(["answered"]));

    // Sent to nobody, so the next request still gets it.
    const next = await call(port, "GET").response;
    expect(next.status).toBe(200);
    expect(JSON.parse(next.body)).toEqual({
        id,
        status: "answered",
        response: "The parser.",
        synthetic: false,
    });
    // That one arrived, so the question is gone.
    await vi.waitFor(async () => expect((await call(port, "GET").response).status).toBe(404));
});
