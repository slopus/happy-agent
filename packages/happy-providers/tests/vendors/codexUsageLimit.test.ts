import { testContext } from "../testContext.js";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebSocketError } from "openai/resources/responses/internal-base";
import { afterEach, describe, expect, it } from "vitest";

import type { SessionEvent } from "@/core/SessionEvent.js";
import { BedrockBearerTokenCredential } from "@/vendors/bedrock/BedrockBearerTokenCredential.js";
import { CodexProvider } from "@/vendors/codex/CodexProvider.js";
import { CodexSession } from "@/vendors/codex/CodexSession.js";
import {
    codexUsageExhaustionMessage,
    readCodexUsageExhaustion,
} from "@/vendors/codex/errors/codexErrors.js";

/**
 * An exhausted Codex account answers with 429, the same status an overloaded backend uses, and the
 * default budget of ten retries turns that into minutes of silence before the person is told. These
 * replay the recorded rejections through the real transport so the distinction is proven where it
 * is actually made: on the parsed error, the `done` event, and the number of requests sent.
 */
describe("Codex usage exhaustion", () => {
    const servers: Server[] = [];
    const sessions: CodexSession[] = [];

    afterEach(async () => {
        for (const session of sessions) session.destroy();
        sessions.length = 0;
        await Promise.all(
            servers.splice(0).map(
                (server) =>
                    new Promise<void>((resolve) => {
                        server.close(() => resolve());
                    }),
            ),
        );
    });

    it("surfaces an exhausted plan immediately instead of retrying it", async () => {
        const fixture = await recordedResponse("codex-usage-limit-reached-429.json");
        const { events, requests, elapsed } = await run(fixture, {
            credential: { name: "codex-api-key", credential: { apiKey: "test" } } as never,
            model: "gpt-5.6-sol",
        });

        expect(requests).toBe(1);
        expect(events.filter((event) => event.type === "retrying")).toEqual([]);
        // Ten default retries would spend minutes in backoff before this event arrived.
        expect(elapsed).toBeLessThan(2_000);
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            providerError: {
                type: "out_of_tokens",
                resetAt: 1_704_067_242_000,
                diagnostics: { attempts: 1, status: 429 },
            },
        });
        expect(errorMessage(events)).toMatch(
            /^You've hit your Codex usage limit on the ChatGPT Pro plan\. Try again at .+\.$/u,
        );
    });

    it("surfaces a plan that never included Codex immediately", async () => {
        const fixture = await recordedResponse("codex-usage-not-included-429.json");
        const { events, requests } = await run(fixture, {
            credential: { name: "codex-api-key", credential: { apiKey: "test" } } as never,
            model: "gpt-5.6-sol",
        });

        expect(requests).toBe(1);
        expect(events.filter((event) => event.type === "retrying")).toEqual([]);
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            providerError: { type: "out_of_tokens" },
        });
        expect(errorMessage(events)).toBe(
            "Codex is not included in this ChatGPT plan. Upgrade to Plus to keep using it: " +
                "https://chatgpt.com/explore/plus.",
        );
    });

    it("keeps retrying an ordinary Bedrock throttling 429", async () => {
        const fixture = await recordedResponse("codex-bedrock-throttling-429.json");
        const credential = await BedrockBearerTokenCredential.tryLoad({
            bearerToken: "bedrock-test-token",
        });
        const { events, requests } = await run(fixture, {
            credential: credential!,
            endpointPath: "/openai/v1",
            inferenceMaxRetries: 1,
            model: "openai.gpt-5.6-sol",
        });

        expect(requests).toBe(2);
        expect(events).toContainEqual(expect.objectContaining({ type: "retrying", attempt: 1 }));
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            providerError: { type: "rate_limit" },
        });
    });

    it("retries an exhausted plan once under an explicit fatal budget, then succeeds", async () => {
        const fixture = await recordedResponse("codex-usage-limit-reached-429.json");
        let requests = 0;
        const server = createServer(async (request, response) => {
            for await (const _chunk of request) {
                // Drain the request before answering.
            }
            requests += 1;
            if (requests === 1) {
                response.writeHead(fixture.status, fixture.headers);
                response.end(JSON.stringify(fixture.body));
                return;
            }
            completeSse(response);
        });
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
            server.listen(0, "127.0.0.1", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) expect.fail("Missing server port.");

        const session = new CodexSession("codex-usage-limit-fatal-retry", {
            credential: { name: "codex-api-key", credential: { apiKey: "test" } } as never,
            endpoint: `http://127.0.0.1:${address.port}/v1`,
            inferenceFatalRetries: 1,
            installationId: "00000000-0000-4000-8000-000000000002",
            instructions: "Be brief.",
            model: "gpt-5.6-sol",
            transport: "sse",
            userAgent: "rig-test",
        });
        sessions.push(session);

        const events = await runSession(session);

        expect(requests).toBe(2);
        const retrying = events.filter((event) => event.type === "retrying");
        expect(retrying).toHaveLength(1);
        expect(retrying[0]).toMatchObject({ attempt: 1 });
        expect((retrying[0] as { reason: string }).reason).toMatch(/usage limit/iu);
        expect((retrying[0] as { reason: string }).reason).toMatch(/attempt 1 of 1/u);
        expect(events.filter((event) => event.type === "block_reset")).toHaveLength(1);
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
    });

    it("exhausts an explicit fatal budget and reports the usual failure", async () => {
        const fixture = await recordedResponse("codex-usage-limit-reached-429.json");
        const { events, requests } = await run(fixture, {
            credential: { name: "codex-api-key", credential: { apiKey: "test" } } as never,
            inferenceFatalRetries: 1,
            model: "gpt-5.6-sol",
        });

        expect(requests).toBe(2);
        expect(events.filter((event) => event.type === "retrying")).toHaveLength(1);
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            providerError: {
                type: "out_of_tokens",
                resetAt: 1_704_067_242_000,
                diagnostics: { attempts: 2, status: 429 },
            },
        });
        expect(errorMessage(events)).toMatch(
            /^You've hit your Codex usage limit on the ChatGPT Pro plan\. Try again at .+\.$/u,
        );
    });

    it("never retries a context-overflow rejection even with a fatal budget", async () => {
        const { events, requests } = await run(
            {
                status: 400,
                headers: { "content-type": "application/json" },
                body: {
                    error: {
                        code: "context_length_exceeded",
                        message: "This model's maximum context length has been exceeded.",
                    },
                },
            },
            {
                credential: { name: "codex-api-key", credential: { apiKey: "test" } } as never,
                inferenceFatalRetries: 3,
                model: "gpt-5.6-sol",
            },
        );

        expect(requests).toBe(1);
        expect(events.filter((event) => event.type === "retrying")).toEqual([]);
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            kind: "context_overflow",
        });
    });

    it("keeps the transient and fatal budgets independent", async () => {
        const fixture = await recordedResponse("codex-usage-limit-reached-429.json");
        let requests = 0;
        const server = createServer(async (request, response) => {
            for await (const _chunk of request) {
                // Drain the request before answering.
            }
            requests += 1;
            if (requests === 1) {
                response.writeHead(fixture.status, fixture.headers);
                response.end(JSON.stringify(fixture.body));
                return;
            }
            if (requests === 2) {
                // A dropped connection: transient, and it must not find its budget already
                // spent by the fatal retry that preceded it.
                response.destroy();
                return;
            }
            completeSse(response);
        });
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
            server.listen(0, "127.0.0.1", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) expect.fail("Missing server port.");

        const session = new CodexSession("codex-independent-budgets", {
            credential: { name: "codex-api-key", credential: { apiKey: "test" } } as never,
            endpoint: `http://127.0.0.1:${address.port}/v1`,
            inferenceFatalRetries: 1,
            inferenceMaxRetries: 1,
            installationId: "00000000-0000-4000-8000-000000000003",
            instructions: "Be brief.",
            model: "gpt-5.6-sol",
            transport: "sse",
            userAgent: "rig-test",
        });
        sessions.push(session);

        const events = await runSession(session);

        expect(requests).toBe(3);
        expect(events.filter((event) => event.type === "retrying")).toHaveLength(2);
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
    });

    it("passes the provider-level fatal budget through to the session", async () => {
        const fixture = await recordedResponse("codex-usage-limit-reached-429.json");
        let requests = 0;
        const server = createServer(async (request, response) => {
            for await (const _chunk of request) {
                // Drain the request before answering.
            }
            requests += 1;
            if (requests === 1) {
                response.writeHead(fixture.status, fixture.headers);
                response.end(JSON.stringify(fixture.body));
                return;
            }
            completeSse(response);
        });
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
            server.listen(0, "127.0.0.1", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) expect.fail("Missing server port.");

        const codexHome = await mkdtemp(join(tmpdir(), "codex-home-"));
        const previousCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = codexHome;
        try {
            const provider = new CodexProvider({
                credential: { name: "codex-api-key", credential: { apiKey: "test" } } as never,
                endpoint: `http://127.0.0.1:${address.port}/v1`,
                inferenceFatalRetries: 1,
                model: "gpt-5.6-sol",
                transport: "sse",
                userAgent: "rig-test",
            });
            const session = await provider.session("codex-provider-fatal-budget", {
                instructions: "",
            });
            sessions.push(session);

            const events = await runSession(session);

            expect(requests).toBe(2);
            expect(events.filter((event) => event.type === "retrying")).toHaveLength(1);
            expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        } finally {
            if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
            else process.env.CODEX_HOME = previousCodexHome;
            await rm(codexHome, { force: true, recursive: true });
        }
    });

    it("reads the usage body out of the WebSocket wrapper the SDK throws", () => {
        const event = {
            type: "error",
            status: 429,
            error: {
                type: "usage_limit_reached",
                message: "The usage limit has been reached",
                plan_type: "plus",
                resets_at: 1_704_067_242,
            },
        };

        expect(
            readCodexUsageExhaustion(new WebSocketError(JSON.stringify(event), event as never)),
        ).toEqual({
            kind: "usage_limit_reached",
            planType: "plus",
            resetAt: 1_704_067_242_000,
        });
    });

    it("falls back to the reset header when the body omits one", async () => {
        const fixture = await recordedResponse("codex-usage-limit-reached-429.json");
        const body = structuredClone(fixture.body) as {
            error: { resets_at?: number };
        };
        delete body.error.resets_at;

        const { events, requests } = await run(
            { ...fixture, body },
            {
                credential: { name: "codex-api-key", credential: { apiKey: "test" } } as never,
                model: "gpt-5.6-sol",
            },
        );

        expect(requests).toBe(1);
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            providerError: { type: "out_of_tokens", resetAt: 1_704_069_000_000 },
        });
    });

    it("names the reset with a clock time today and a date beyond it", () => {
        const resetAt = Date.parse("2026-08-07T15:45:00Z");

        expect(
            codexUsageExhaustionMessage(
                { kind: "usage_limit_reached", planType: "pro", resetAt },
                resetAt - 60_000,
            ),
        ).toMatch(
            /^You've hit your Codex usage limit on the ChatGPT Pro plan\. Try again at \d{1,2}:\d{2} [AP]M\.$/u,
        );
        expect(
            codexUsageExhaustionMessage(
                { kind: "usage_limit_reached", resetAt },
                resetAt - 5 * 24 * 60 * 60 * 1_000,
            ),
        ).toMatch(
            /^You've hit your Codex usage limit\. Try again at [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M\.$/u,
        );
        expect(codexUsageExhaustionMessage({ kind: "usage_limit_reached" })).toBe(
            "You've hit your Codex usage limit. Try again later.",
        );
    });

    interface RecordedResponse {
        status: number;
        headers: Record<string, string>;
        body: unknown;
    }

    async function recordedResponse(name: string): Promise<RecordedResponse> {
        return JSON.parse(
            await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
        ) as RecordedResponse;
    }

    async function run(
        recorded: RecordedResponse,
        options: {
            credential: ConstructorParameters<typeof CodexSession>[1]["credential"];
            endpointPath?: string;
            inferenceFatalRetries?: number;
            inferenceMaxRetries?: number;
            model: string;
        },
    ): Promise<{ elapsed: number; events: SessionEvent[]; requests: number }> {
        let requests = 0;
        const server = createServer(async (request, response) => {
            for await (const _chunk of request) {
                // Drain the request before answering.
            }
            requests += 1;
            response.writeHead(recorded.status, recorded.headers);
            response.end(JSON.stringify(recorded.body));
        });
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
            server.listen(0, "127.0.0.1", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) expect.fail("Missing server port.");

        const session = new CodexSession("codex-usage-limit", {
            credential: options.credential,
            endpoint: `http://127.0.0.1:${address.port}${options.endpointPath ?? "/v1"}`,
            installationId: "00000000-0000-4000-8000-000000000001",
            instructions: "Be brief.",
            model: options.model,
            ...(options.inferenceFatalRetries === undefined
                ? {}
                : { inferenceFatalRetries: options.inferenceFatalRetries }),
            ...(options.inferenceMaxRetries === undefined
                ? {}
                : { inferenceMaxRetries: options.inferenceMaxRetries }),
            transport: "sse",
            userAgent: "rig-test",
        });
        sessions.push(session);

        const startedAt = Date.now();
        const events = await runSession(session);
        return { elapsed: Date.now() - startedAt, events, requests };
    }
});

async function runSession(session: CodexSession): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    for await (const event of session.run(testContext, {
        context: {
            instructions: "",
            messages: [{ role: "user", content: [{ type: "text" as const, text: "Reply with OK." }] }],
        },
        effort: "low",
    })) {
        events.push(event);
    }
    return events;
}

/** The minimal successful Codex SSE response: an empty output with reported usage. */
function completeSse(response: ServerResponse): void {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
        [
            {
                type: "response.completed",
                response: {
                    id: "response",
                    output: [],
                    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
            },
        ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join("") + "data: [DONE]\n\n",
    );
}

function errorMessage(events: readonly SessionEvent[]): string {
    const done = events.at(-1);
    if (done?.type !== "done" || done.state !== "error") expect.fail("Missing terminal failure.");
    return done.message;
}
