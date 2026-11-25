import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withLifetime } from "@steve.kite/stdlib";

import { CodexProvider } from "@/vendors/codex/CodexProvider.js";
import { CodexSessionCredential } from "@/vendors/codex/CodexSessionCredential.js";
import type { SessionEvent, SessionStream } from "@/core/SessionEvent.js";
import { assistantMessageFromEvents } from "@/core/SessionAssistantMessageAccumulator.js";
import { testContext } from "./testContext.js";

vi.mock("@/vendors/codex/impl/resolveCodexInstallationId.js", () => ({
    resolveCodexInstallationId: async () => "diagnostic-installation",
}));

const directories: string[] = [];
afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

// Synthetic responses, not a recording of the user's incident. No network or real credentials.
describe("Codex concurrent authentication recovery", () => {
    it.each([200, 400])(
        "adopts a same-account external rotation after our refresh returns HTTP %s",
        async (status) => {
            const { authFile, load } = await fixture();
            const credential = await load();
            const inferenceTokens: string[] = [];
            let refreshes = 0;
            vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
                if (String(input).endsWith("/oauth/token")) {
                    refreshes += 1;
                    // A separate owner saves a usable login while this exchange is pending.
                    await writeAuth(authFile, "external-fresh", "account-a");
                    return Response.json(
                        { access_token: "our-fresh", refresh_token: "our-refresh" },
                        { status },
                    );
                }
                const token = new Headers(init?.headers).get("authorization") ?? "";
                inferenceTokens.push(token);
                return token === "Bearer external-fresh" ? success() : unauthorized();
            });
            const session = await new CodexProvider({
                credential,
                endpoint: "https://diagnostic.invalid/backend-api",
                model: "gpt-5.6-sol",
                transport: "sse",
                inferenceMaxRetries: 0,
            }).session("same-session", { instructions: "" });
            try {
                const first = await collectSessionEvents(session.run(testContext, request));
                expect(first.at(-1)).toMatchObject({ type: "done", state: "normal" });
                expect(refreshes).toBe(1);
                const followup = await collectSessionEvents(session.run(testContext, request));
                expect(followup.at(-1)).toMatchObject({ type: "done", state: "normal" });
                expect(inferenceTokens).toEqual([
                    "Bearer stale",
                    "Bearer stale",
                    "Bearer external-fresh",
                    "Bearer external-fresh",
                ]);
                expect(refreshes).toBe(1);
                expect(await readFile(authFile, "utf8")).toContain("external-fresh");
            } finally {
                await session.destroy();
            }
        },
        // The first test in this file pays the session stack's one-time startup. Nothing here waits
        // on a clock, so a generous budget only absorbs a starved machine; a real hang still fails.
        30_000,
    );

    it("an account switch keeps the old session failing while a newly loaded session works", async () => {
        const { authFile, load } = await fixture();
        const original = await load();
        await writeAuth(authFile, "new-account-token", "account-b");
        let refreshes = 0;
        vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
            if (String(input).endsWith("/oauth/token")) {
                refreshes += 1;
                throw new Error("Account switch must not refresh the replacement account.");
            }
            return new Headers(init?.headers).get("authorization") === "Bearer new-account-token"
                ? success()
                : unauthorized();
        });
        const provider = (credential: CodexSessionCredential) =>
            new CodexProvider({
                credential,
                endpoint: "https://diagnostic.invalid/backend-api",
                model: "gpt-5.6-sol",
                transport: "sse",
                inferenceMaxRetries: 0,
            });
        const oldSession = await provider(original).session("old", { instructions: "" });
        const newSession = await provider(await load()).session("new", { instructions: "" });
        try {
            for (let turn = 0; turn < 2; turn += 1) {
                const events = await collectSessionEvents(oldSession.run(testContext, request));
                expect(events.at(-1)).toMatchObject({
                    type: "done",
                    state: "error",
                    providerError: { type: "authentication" },
                });
            }
            const events = await collectSessionEvents(newSession.run(testContext, request));
            expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
            expect(refreshes).toBe(0);
        } finally {
            await oldSession.destroy();
            await newSession.destroy();
        }
    });

    it.each(["different account", "removed login", "unchanged token", "unknown original account"])(
        "does not adopt or overwrite an external change with %s",
        async (change) => {
            const { authFile, load } = await fixture();
            const credential =
                change === "unknown original account"
                    ? CodexSessionCredential.fromAuth(
                          { accessToken: "stale" },
                          {
                              authFile,
                              env: {
                                  CODEX_REFRESH_TOKEN_URL_OVERRIDE:
                                      "https://diagnostic.invalid/oauth/token",
                              },
                          },
                      )
                    : await load();
            let expectedFile: string | undefined;
            vi.stubGlobal("fetch", async () => {
                if (change === "removed login") {
                    await rm(authFile);
                } else {
                    expectedFile = JSON.stringify({
                        marker: "external-change",
                        tokens: {
                            access_token: change === "unchanged token" ? "stale" : "external-fresh",
                            refresh_token: "external-refresh",
                            account_id: change === "different account" ? "account-b" : "account-a",
                        },
                    });
                    await writeFile(authFile, expectedFile);
                }
                return Response.json({ access_token: "our-fresh", refresh_token: "our-refresh" });
            });
            await expect(credential.refreshForUnauthorized()).rejects.toThrow();
            if (expectedFile === undefined) {
                await expect(readFile(authFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
            } else {
                expect(await readFile(authFile, "utf8")).toBe(expectedFile);
            }
        },
    );

    it("stops after the adopted replacement is also rejected", async () => {
        const { authFile, load } = await fixture();
        const credential = await load();
        let refreshes = 0;
        let inferences = 0;
        vi.stubGlobal("fetch", async (input: string | URL | Request) => {
            if (String(input).endsWith("/oauth/token")) {
                refreshes += 1;
                await writeAuth(authFile, "external-fresh", "account-a");
                return Response.json({}, { status: 400 });
            }
            inferences += 1;
            return unauthorized();
        });
        const session = await new CodexProvider({
            credential,
            endpoint: "https://diagnostic.invalid/backend-api",
            model: "gpt-5.6-sol",
            transport: "sse",
            inferenceMaxRetries: 0,
        }).session("bounded-recovery", { instructions: "" });
        try {
            const events = await collectSessionEvents(session.run(testContext, request));
            expect(events.at(-1)).toMatchObject({
                type: "done",
                state: "error",
                providerError: { type: "authentication" },
            });
            expect(refreshes).toBe(1);
            expect(inferences).toBe(3);
        } finally {
            session.destroy();
        }
    });
});

const request = {
    context: {
        instructions: "",
        messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] }],
    },
};

const terminalRecoveryMessage =
    "Codex authentication could not be renewed for this account. Try again; if it keeps failing, sign in to Codex again with the same account.";

const { WebSocketServer } = createRequire(createRequire(import.meta.url).resolve("openai"))(
    "ws",
) as typeof import("ws");

describe("Codex terminal credential-recovery failures", () => {
    it.each([
        { status: 200, change: "removed login" },
        { status: 400, change: "different account" },
    ])(
        "returns a safe authentication terminal for HTTP $status and $change",
        async ({ status, change }) => {
            const { authFile } = await fixture();
            let expectedFile: string | undefined;
            const recovery = await recoverySession(authFile, async () => {
                if (change === "removed login") await rm(authFile);
                else {
                    expectedFile = JSON.stringify({
                        marker: "external-owner",
                        tokens: {
                            access_token: "external-token",
                            refresh_token: "external-refresh",
                            account_id: "account-b",
                        },
                    });
                    await writeFile(authFile, expectedFile);
                }
                return Response.json({ access_token: "our-token" }, { status });
            });
            const { session, counts } = recovery;
            try {
                const events = await collectSessionEvents(session.run(testContext, request));
                expectSafeRecoveryTerminal(events, authFile);
                expect(counts).toEqual({ inferences: 2, refreshes: 1 });
                if (expectedFile === undefined) {
                    await expect(readFile(authFile, "utf8")).rejects.toMatchObject({
                        code: "ENOENT",
                    });
                } else expect(await readFile(authFile, "utf8")).toBe(expectedFile);
            } finally {
                await recovery.close();
            }
        },
    );

    it("names the OAuth code that refused renewal without its free text", async () => {
        const { authFile } = await fixture();
        const recovery = await recoverySession(authFile, async () =>
            Response.json(
                { error: { code: "refresh_token_reused", message: "secret-free-text" } },
                { status: 401 },
            ),
        );
        try {
            const events = await collectSessionEvents(recovery.session.run(testContext, request));
            expectSafeRecoveryTerminal(events, authFile);
            expect(events.at(-1)).toMatchObject({
                providerError: { diagnostics: { status: 401, code: "refresh_token_reused" } },
            });
            expect(JSON.stringify(events.at(-1))).not.toContain("secret-free-text");
        } finally {
            await recovery.close();
        }
    });

    it("retracts partial output and emits one terminal after a refresh failure", async () => {
        const { authFile } = await fixture();
        const before = await readFile(authFile, "utf8");
        let finishAttempt = () => {};
        const counts = { inferences: 0, refreshes: 0 };
        const server = createServer((_request, reply) => {
            counts.refreshes += 1;
            reply.writeHead(400, { "content-type": "application/json" });
            reply.end("{}");
        });
        const sockets = new WebSocketServer({ server });
        sockets.on("connection", (socket) => {
            socket.on("message", (data) => {
                if (JSON.parse(String(data)).generate === false) {
                    socket.send(
                        JSON.stringify({
                            type: "response.completed",
                            response: {
                                id: "warm",
                                output: [],
                                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                            },
                        }),
                    );
                    return;
                }
                counts.inferences += 1;
                finishAttempt = () =>
                    socket.send(
                        JSON.stringify({
                            type: "error",
                            status: 401,
                            error: {
                                type: "authentication_error",
                                message: "Synthetic credential rejected.",
                            },
                        }),
                    );
                socket.send(
                    JSON.stringify({
                        type: "response.output_item.added",
                        output_index: 0,
                        item: {
                            id: "partial",
                            type: "message",
                            role: "assistant",
                            status: "in_progress",
                            content: [],
                        },
                    }),
                );
                socket.send(
                    JSON.stringify({
                        type: "response.content_part.added",
                        item_id: "partial",
                        output_index: 0,
                        content_index: 0,
                        part: { type: "output_text", text: "", annotations: [] },
                    }),
                );
                socket.send(
                    JSON.stringify({
                        type: "response.output_text.delta",
                        item_id: "partial",
                        output_index: 0,
                        content_index: 0,
                        delta: "tentative output",
                    }),
                );
            });
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string")
            throw new Error("Missing fixture port.");
        const endpoint = `http://127.0.0.1:${address.port}`;
        const credential = await CodexSessionCredential.tryLoad({
            authFile,
            env: { CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${endpoint}/oauth/token` },
        });
        if (credential === null) throw new Error("Synthetic credential missing.");
        const session = await new CodexProvider({
            credential,
            endpoint: `${endpoint}/backend-api`,
            transport: "websocket",
            parallelToolCalls: true,
            model: "gpt-5.6-sol",
            inferenceMaxRetries: 0,
        }).session("partial-recovery", { instructions: "" });
        const events: SessionEvent[] = [];
        try {
            for await (const event of session.run(testContext, request)) {
                events.push(event);
                if (event.type === "text_delta") finishAttempt();
            }
            const firstText = events.findIndex((event) => event.type === "text_delta");
            const firstReset = events.findIndex((event) => event.type === "block_reset");
            expect(firstText).toBeGreaterThan(-1);
            expect(firstReset).toBeGreaterThan(firstText);
            expectSafeRecoveryTerminal(events, authFile);
            expect(assistantMessageFromEvents(events)).toBeUndefined();
            expect(counts).toEqual({ inferences: 2, refreshes: 1 });
            expect(await readFile(authFile, "utf8")).toBe(before);
        } finally {
            await session.destroy();
            for (const socket of sockets.clients) socket.terminate();
            await new Promise<void>((resolve) => sockets.close(() => resolve()));
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("returns cancelled when aborted during the pending credential refresh", async () => {
        const { authFile } = await fixture();
        const before = await readFile(authFile, "utf8");
        const started = recoveryBarrier();
        const release = recoveryBarrier();
        const controller = new AbortController();
        const recovery = await recoverySession(authFile, async () => {
            started.resolve();
            await release.promise;
            return Response.json({}, { status: 400 });
        });
        const { session, counts } = recovery;
        const running = collectSessionEvents(
            session.run(withLifetime(testContext, controller.signal), request),
        );
        void running.catch(() => undefined);
        try {
            await started.promise;
            controller.abort();
            release.resolve();
            const events = await running;
            expect(events.filter((event) => event.type === "done")).toEqual([
                { type: "done", state: "cancelled" },
            ]);
            expect(counts).toEqual({ inferences: 2, refreshes: 1 });
            expect(await readFile(authFile, "utf8")).toBe(before);
        } finally {
            release.resolve();
            await running.catch(() => undefined);
            await recovery.close();
        }
    });

    it.each([200, 400])(
        "returns the exact safe compaction failure after refresh HTTP %s",
        async (status) => {
            const { authFile } = await fixture();
            const before = await readFile(authFile, "utf8");
            const recovery = await recoverySession(authFile, async () => {
                if (status === 200) await rm(authFile);
                return Response.json({ access_token: "our-token" }, { status });
            });
            const { session, counts } = recovery;
            try {
                await expect(
                    session.compact(testContext, { context: request.context }),
                ).resolves.toEqual({
                    status: "failed",
                    kind: "inference_error",
                    message: terminalRecoveryMessage,
                });
                expect(counts).toEqual({ inferences: 2, refreshes: 1 });
                if (status === 200)
                    await expect(readFile(authFile, "utf8")).rejects.toMatchObject({
                        code: "ENOENT",
                    });
                else expect(await readFile(authFile, "utf8")).toBe(before);
            } finally {
                await recovery.close();
            }
        },
    );

    it("keeps the session context when compaction is cancelled during refresh", async () => {
        const { authFile } = await fixture();
        const before = await readFile(authFile, "utf8");
        const started = recoveryBarrier();
        const release = recoveryBarrier();
        const controller = new AbortController();
        const recovery = await recoverySession(authFile, async () => {
            started.resolve();
            await release.promise;
            return Response.json({}, { status: 400 });
        });
        const { session, counts } = recovery;
        const running = session.compact(withLifetime(testContext, controller.signal), {
            context: request.context,
        });
        void running.catch(() => undefined);
        try {
            await started.promise;
            controller.abort();
            release.resolve();
            await expect(running).resolves.toEqual({
                status: "cancelled",
                context: { instructions: "", messages: [] },
            });
            expect(counts).toEqual({ inferences: 2, refreshes: 1 });
            expect(await readFile(authFile, "utf8")).toBe(before);
        } finally {
            release.resolve();
            await running.catch(() => undefined);
            await recovery.close();
        }
    });
});

async function recoverySession(
    authFile: string,
    refresh: () => Promise<Response>,
    inference: () => Response = unauthorized,
) {
    const counts = { inferences: 0, refreshes: 0 };
    const server = createServer(async (request, reply) => {
        let response: Response;
        if (request.url === "/oauth/token") {
            counts.refreshes += 1;
            response = await refresh();
        } else {
            counts.inferences += 1;
            response = inference();
        }
        reply.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body !== null) {
            for await (const chunk of response.body) reply.write(chunk);
        }
        reply.end();
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing fixture port.");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const credential = await CodexSessionCredential.tryLoad({
        authFile,
        env: { CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${endpoint}/oauth/token` },
    });
    if (credential === null) throw new Error("Synthetic credential missing.");
    const session = await new CodexProvider({
        credential,
        endpoint: `${endpoint}/backend-api`,
        model: "gpt-5.6-sol",
        transport: "sse",
        inferenceMaxRetries: 0,
    }).session("terminal-auth-recovery", { instructions: "" });
    return {
        session,
        counts,
        close: async () => {
            await session.destroy();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

function expectSafeRecoveryTerminal(events: readonly SessionEvent[], authFile: string) {
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
        type: "done",
        state: "error",
        message: terminalRecoveryMessage,
        providerError: { type: "authentication", diagnostics: { status: 401 } },
    });
    expect(JSON.stringify(events.at(-1))).not.toContain(authFile);
    expect(JSON.stringify(events.at(-1))).not.toMatch(
        /ENOENT|HTTP 400|changed during token refresh/,
    );
}

function recoveryBarrier() {
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, resolve: () => release() };
}

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "codex-followup-diagnostic-"));
    directories.push(directory);
    const authFile = join(directory, "auth.json");
    await writeAuth(authFile, "stale", "account-a");
    return {
        authFile,
        load: async () => {
            const credential = await CodexSessionCredential.tryLoad({
                authFile,
                env: { CODEX_REFRESH_TOKEN_URL_OVERRIDE: "https://diagnostic.invalid/oauth/token" },
            });
            if (credential === null) throw new Error("Synthetic credential missing.");
            return credential;
        },
    };
}

async function writeAuth(path: string, token: string, account: string) {
    await writeFile(
        path,
        JSON.stringify({
            tokens: {
                access_token: token,
                refresh_token: "synthetic-refresh",
                account_id: account,
            },
        }),
    );
}

function unauthorized() {
    return Response.json(
        { error: { type: "authentication_error", message: "expired" } },
        { status: 401 },
    );
}

function success() {
    return new Response(
        'data: {"type":"response.completed","response":{"id":"response","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
    );
}

async function collectSessionEvents(stream: SessionStream): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
}
