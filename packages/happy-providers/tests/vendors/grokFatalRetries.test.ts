import { testContext } from "../testContext.js";

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { assistantMessageFromEvents } from "@/core/SessionAssistantMessageAccumulator.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import { isSessionErrorDone } from "@/core/SessionEvent.js";
import { GrokApiKeyCredential } from "@/vendors/grok/GrokApiKeyCredential.js";
import { GrokProvider } from "@/vendors/grok/GrokProvider.js";
import type { GrokSession } from "@/vendors/grok/GrokSession.js";

vi.mock("@/vendors/grok/impl/grokRetry.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/vendors/grok/impl/grokRetry.js")>();
    return { ...actual, delayBeforeGrokRetry: () => Promise.resolve() };
});

const servers: ReturnType<typeof createServer>[] = [];

afterEach(() => {
    for (const server of servers.splice(0)) {
        server.close();
        server.closeAllConnections();
    }
});

describe("Grok fatal-budget retries", () => {
    it("reports a spent account immediately as out_of_tokens under the default fatal budget", async () => {
        let requests = 0;
        const endpoint = await serve((_body, response) => {
            requests += 1;
            billingError(response);
        });
        const session = await createSession(endpoint);

        const events = await runToCompletion(session);

        expect(requests).toBe(1);
        expect(events.filter((event) => event.type === "retrying")).toHaveLength(0);
        const terminal = events.at(-1);
        if (terminal === undefined) throw new Error("Expected a terminal event.");
        expect(isSessionErrorDone(terminal)).toBe(true);
        if (!isSessionErrorDone(terminal)) throw new Error("Expected an error done event.");
        expect(terminal.kind).toBe("billing_error");
        expect(terminal.providerError).toMatchObject({ type: "out_of_tokens" });
    });

    it("retries a spent account once under a configured fatal budget then succeeds", async () => {
        let requests = 0;
        const endpoint = await serve((_body, response, index) => {
            requests += 1;
            if (index === 0) {
                billingError(response);
                return;
            }
            completeText(response, "final answer");
        });
        const session = await createSession(endpoint, { inferenceFatalRetries: 1 });

        const events = await runToCompletion(session);

        expect(requests).toBe(2);
        const retrying = events.filter(isRetryingEvent);
        expect(retrying).toHaveLength(1);
        expect(retrying[0]).toMatchObject({ attempt: 1 });
        expect(retrying[0]?.reason).toContain("subscription:free-usage-exhausted");
        expect(retrying[0]?.reason).toContain("attempt 1 of 1");
        expect(events.filter((event) => event.type === "block_reset")).toHaveLength(1);
        expect(events.filter((event) => event.type === "block_start")).toHaveLength(2);
        const terminal = events.at(-1);
        expect(terminal).toMatchObject({ type: "done", state: "normal" });
        expect(assistantMessageFromEvents(events)).toEqual({
            role: "assistant",
            content: [{ type: "text", text: "final answer" }],
        });
    });

    it("falls through to today's out_of_tokens error once the fatal budget is exhausted", async () => {
        let requests = 0;
        const endpoint = await serve((_body, response) => {
            requests += 1;
            billingError(response);
        });
        const session = await createSession(endpoint, { inferenceFatalRetries: 1 });

        const events = await runToCompletion(session);

        expect(requests).toBe(2);
        const retrying = events.filter(isRetryingEvent);
        expect(retrying).toHaveLength(1);
        expect(retrying[0]).toMatchObject({ attempt: 1 });
        const terminal = events.at(-1);
        if (terminal === undefined) throw new Error("Expected a terminal event.");
        expect(isSessionErrorDone(terminal)).toBe(true);
        if (!isSessionErrorDone(terminal)) throw new Error("Expected an error done event.");
        expect(terminal.kind).toBe("billing_error");
        expect(terminal.providerError).toMatchObject({
            type: "out_of_tokens",
            diagnostics: expect.objectContaining({ attempts: 2 }),
        });
    });

    it("never retries a context overflow disguised as a retryable 429", async () => {
        let requests = 0;
        const endpoint = await serve((_body, response) => {
            requests += 1;
            response.writeHead(429, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    error: { message: "prompt is too long: 300000 tokens > 200000 maximum" },
                }),
            );
        });
        const session = await createSession(endpoint, { inferenceFatalRetries: 5 });

        const events = await runToCompletion(session);

        expect(requests).toBe(1);
        expect(events.filter((event) => event.type === "retrying")).toHaveLength(0);
        const terminal = events.at(-1);
        if (terminal === undefined) throw new Error("Expected a terminal event.");
        expect(isSessionErrorDone(terminal)).toBe(true);
        if (!isSessionErrorDone(terminal)) throw new Error("Expected an error done event.");
        expect(terminal.kind).toBe("context_overflow");
    });

    it("never retries a context overflow even with a fatal budget configured", async () => {
        let requests = 0;
        const endpoint = await serve((_body, response) => {
            requests += 1;
            response.writeHead(400, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    error: { message: "prompt is too long: 300000 tokens > 200000 maximum" },
                }),
            );
        });
        const session = await createSession(endpoint, { inferenceFatalRetries: 5 });

        const events = await runToCompletion(session);

        expect(requests).toBe(1);
        expect(events.filter((event) => event.type === "retrying")).toHaveLength(0);
        const terminal = events.at(-1);
        if (terminal === undefined) throw new Error("Expected a terminal event.");
        expect(isSessionErrorDone(terminal)).toBe(true);
        if (!isSessionErrorDone(terminal)) throw new Error("Expected an error done event.");
        expect(terminal.kind).toBe("context_overflow");
    });

    it("still retries an ordinary transient 429 under the transient budget, unaffected by the fatal budget", async () => {
        let requests = 0;
        const endpoint = await serve((_body, response, index) => {
            requests += 1;
            if (index === 0) {
                response.writeHead(429, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: { message: "rate limited" } }));
                return;
            }
            completeText(response, "final answer");
        });
        const session = await createSession(endpoint, { inferenceFatalRetries: 5 });

        const events = await runToCompletion(session);

        expect(requests).toBe(2);
        const retrying = events.filter((event) => event.type === "retrying");
        expect(retrying).toHaveLength(1);
        expect(retrying[0]).toMatchObject({ attempt: 1, reason: "429 rate limited" });
        const terminal = events.at(-1);
        expect(terminal).toMatchObject({ type: "done", state: "normal" });
    });
});

function isRetryingEvent(
    event: SessionEvent,
): event is Extract<SessionEvent, { type: "retrying" }> {
    return event.type === "retrying";
}

async function createSession(endpoint: string, options?: { inferenceFatalRetries?: number }) {
    const credential = await GrokApiKeyCredential.tryLoad({ apiKey: "test" });
    if (credential === null) throw new Error("Missing test credential.");
    const provider = new GrokProvider({
        credential,
        endpoint,
        model: "grok-4.5",
        ...options,
    });
    return provider.session("session", {
        instructions: "System prompt.",
        tools: [],
    });
}

async function runToCompletion(session: GrokSession): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    for await (const event of session.run(testContext, {
        context: {
            instructions: "",
            messages: [
                {
                    role: "user",
                    content: [{ type: "text" as const, text: "Original query." }],
                },
            ],
        },
    })) {
        events.push(event);
    }
    return events;
}

function billingError(response: ServerResponse): void {
    response.writeHead(429, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "subscription:free-usage-exhausted" } }));
}

async function serve(
    handler: (
        body: string,
        response: ServerResponse,
        index: number,
        request: IncomingMessage,
    ) => void,
): Promise<string> {
    let index = 0;
    const server = createServer(async (request, response) => {
        handler(await readBody(request), response, index++, request);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("Missing port.");
    return `http://127.0.0.1:${address.port}/v1`;
}

function completeText(response: ServerResponse, text: string): void {
    response.writeHead(200, { "content-type": "text/event-stream" });
    sendMessageStart(response);
    send(response, { type: "response.output_text.delta", output_index: 0, delta: text });
    send(response, {
        type: "response.output_item.done",
        output_index: 0,
        item: {
            type: "message",
            id: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
        },
    });
    send(response, {
        type: "response.completed",
        response: {
            id: "response",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
    });
    response.end("data: [DONE]\n\n");
}

function sendMessageStart(response: ServerResponse): void {
    send(response, {
        type: "response.output_item.added",
        output_index: 0,
        item: {
            type: "message",
            id: "message",
            role: "assistant",
            status: "in_progress",
            content: [],
        },
    });
}

function send(response: ServerResponse, event: Record<string, unknown>): void {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            body += chunk;
        });
        request.once("end", () => resolve(body));
        request.once("error", reject);
    });
}
