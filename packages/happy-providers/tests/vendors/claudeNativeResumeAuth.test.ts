import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@/core/SessionEvent.js";
import { ClaudeCodeCredential } from "@/vendors/claude/ClaudeCodeCredential.js";
import { ClaudeSession } from "@/vendors/claude/ClaudeSession.js";
import { testContext } from "../testContext.js";
import fixture from "./fixtures/claude-provider-multiturn.json" with { type: "json" };

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

// Linux uses the native file credential backend. Run this in an offline container: the real
// SDK subprocess, opaque history resume, OAuth refresh, locks and credential writes all run.
// macOS keychain namespace binding is covered separately without touching the host keychain.
describe.skipIf(process.platform !== "linux")(
    "Claude native authentication on history resume",
    () => {
        it.each([
            { state: "expired", retries: 1 },
            { state: "rejected while unexpired", retries: 1 },
            { state: "rejected while unexpired", retries: 0 },
        ] as const)(
            "uses only the original selected credential when $state (native retry budget: $retries)",
            { timeout: 30_000 },
            async ({ state, retries }) => {
                const root = await mkdtemp(join(tmpdir(), "claude-native-resume-auth-"));
                const selected = join(root, "selected");
                await mkdir(selected);
                const original = join(selected, ".credentials.json");
                await writeFile(
                    original,
                    JSON.stringify({
                        claudeAiOauth: {
                            accessToken: "synthetic-original-access",
                            refreshToken: "synthetic-original-refresh",
                            expiresAt: state === "expired" ? 1 : Date.now() + 3_600_000,
                            scopes: ["user:inference", "user:profile"],
                            subscriptionType: "max",
                            rateLimitTier: "default_claude_max_20x",
                        },
                    }),
                );
                vi.stubEnv("CLAUDE_CONFIG_DIR", selected);
                const credential = await ClaudeCodeCredential.tryLoad({
                    configDir: selected,
                    env: {},
                });
                if (credential === null) throw new Error("Missing synthetic native credential.");
                const success = fixture.exchanges[1]!.response.events.map(
                    (event: { type: string }) =>
                        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                ).join("");
                const refreshBodies: string[] = [];
                const inferenceAuthorizations: string[] = [];
                const inferenceBodies: string[] = [];
                const server = createServer(async (request, response) => {
                    const url = new URL(request.url ?? "/", "http://fixture.invalid");
                    let body = "";
                    for await (const chunk of request) body += String(chunk);
                    if (url.pathname === "/v1/oauth/token") {
                        refreshBodies.push(body);
                        response.writeHead(200, { "content-type": "application/json" });
                        response.end(
                            JSON.stringify({
                                access_token: "synthetic-refreshed-access",
                                refresh_token: "synthetic-rotated-refresh",
                                expires_in: 28_800,
                                scope: "user:inference user:profile",
                            }),
                        );
                    } else if (url.pathname === "/v1/messages" && request.method === "POST") {
                        inferenceAuthorizations.push(request.headers.authorization ?? "");
                        inferenceBodies.push(body);
                        if (request.headers.authorization !== "Bearer synthetic-refreshed-access") {
                            response.writeHead(401, { "content-type": "application/json" });
                            response.end(
                                JSON.stringify({
                                    type: "error",
                                    error: {
                                        type: "authentication_error",
                                        message: "Synthetic OAuth access token has been revoked.",
                                    },
                                }),
                            );
                            return;
                        }
                        response.writeHead(200, { "content-type": "text/event-stream" });
                        response.end(success);
                    } else {
                        response.writeHead(404, { "content-type": "application/json" });
                        response.end("{}");
                    }
                });
                // The native refresh endpoint is fixed HTTPS. Terminate its proxy tunnel locally;
                // never resolve or forward a request to a vendor. This CA exists only in the fixture.
                const keyPath = join(root, "fixture-key.pem");
                const certPath = join(root, "fixture-cert.pem");
                execFileSync(
                    "openssl",
                    [
                        "req",
                        "-x509",
                        "-newkey",
                        "rsa:2048",
                        "-nodes",
                        "-days",
                        "1",
                        "-subj",
                        "/CN=platform.claude.com",
                        "-addext",
                        "subjectAltName=DNS:platform.claude.com,DNS:api.anthropic.com",
                        "-keyout",
                        keyPath,
                        "-out",
                        certPath,
                    ],
                    { stdio: "ignore" },
                );
                const tlsServer = createHttpsServer({
                    key: readFileSync(keyPath),
                    cert: readFileSync(certPath),
                });
                tlsServer.on("request", (request, response) =>
                    server.emit("request", request, response),
                );
                server.on("connect", (request, socket) => {
                    if (
                        !["platform.claude.com:443", "api.anthropic.com:443"].includes(
                            request.url ?? "",
                        )
                    ) {
                        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
                        return;
                    }
                    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                    tlsServer.emit("connection", socket);
                });
                await new Promise<void>((resolve, reject) => {
                    server.once("error", reject);
                    server.listen(0, "127.0.0.1", resolve);
                });
                const address = server.address();
                if (address === null || typeof address === "string")
                    throw new Error("Missing fixture port.");
                const origin = `http://127.0.0.1:${address.port}`;
                const exits: Promise<void>[] = [];
                let childEnvironment: NodeJS.ProcessEnv | undefined;
                let stagedPath: string | undefined;
                let resumedHistory: string | undefined;
                let stderr = "";
                const session = new ClaudeSession("native-resume-auth", {
                    credential,
                    cwd: root,
                    instructions: "",
                    model: "opus[1m]",
                    inferenceMaxRetries: retries,
                    tools: [],
                    env: {
                        PATH: process.env.PATH,
                        TMPDIR: root,
                        CLAUDE_CODE_TMPDIR: root,
                        ANTHROPIC_BASE_URL: origin,
                        HTTP_PROXY: origin,
                        HTTPS_PROXY: origin,
                        http_proxy: origin,
                        https_proxy: origin,
                        NO_PROXY: "127.0.0.1,localhost",
                        no_proxy: "127.0.0.1,localhost",
                        NODE_EXTRA_CA_CERTS: certPath,
                        CLAUDE_CODE_OAUTH_401_WAIT_MS: "0",
                    },
                    query: (parameters) => {
                        const store = parameters.options?.sessionStore;
                        if (store === undefined) throw new Error("Missing native history store.");
                        return query({
                            ...parameters,
                            options: {
                                ...parameters.options,
                                sessionStore: {
                                    ...store,
                                    load: async (key) => {
                                        const entries = await store.load(key);
                                        resumedHistory = JSON.stringify(entries);
                                        return entries;
                                    },
                                },
                                debug: true,
                                debugFile: join(root, "sdk-debug.txt"),
                                spawnClaudeCodeProcess: (options) => {
                                    childEnvironment = options.env;
                                    if (!options.env.CLAUDE_CONFIG_DIR?.includes("claude-resume-"))
                                        throw new Error("Missing SDK history staging.");
                                    stagedPath = join(
                                        options.env.CLAUDE_CONFIG_DIR,
                                        ".credentials.json",
                                    );
                                    writeFileSync(
                                        stagedPath,
                                        JSON.stringify({
                                            claudeAiOauth: {
                                                accessToken: "synthetic-unrelated-staged-access",
                                                expiresAt: Date.now() + 3_600_000,
                                                scopes: ["user:inference"],
                                                subscriptionType: "max",
                                            },
                                        }),
                                    );
                                    const child = spawn(options.command, options.args, {
                                        cwd: options.cwd,
                                        env: options.env,
                                        signal: options.signal,
                                        stdio: ["pipe", "pipe", "pipe"],
                                    });
                                    child.stderr.on("data", (chunk) => {
                                        stderr = (stderr + String(chunk)).slice(-2048);
                                    });
                                    exits.push(
                                        new Promise<void>((resolve) =>
                                            child.once("close", () => resolve()),
                                        ),
                                    );
                                    return child;
                                },
                            },
                        });
                    },
                });
                try {
                    const events: SessionEvent[] = [];
                    for await (const event of session.run(testContext, {
                        context: {
                            instructions: "",
                            messages: [
                                {
                                    role: "user",
                                    content: [{ type: "text", text: "First request." }],
                                },
                                {
                                    role: "assistant",
                                    content: [
                                        {
                                            type: "reasoning",
                                            reasoning: "synthetic-opaque-reasoning",
                                        },
                                        { type: "text", text: "First answer." },
                                    ],
                                },
                                { role: "user", content: [{ type: "text", text: "Continue." }] },
                            ],
                        },
                    }))
                        events.push(event);
                    const authDebug = (
                        await readFile(join(root, "sdk-debug.txt"), "utf8").catch(() => "")
                    )
                        .split("\n")
                        .filter((line) => /oauth|keychain|refresh/i.test(line))
                        .slice(-20)
                        .join("\n");
                    const terminal = expect(
                        events.at(-1),
                        JSON.stringify({
                            terminal: events.at(-1),
                            refreshBodies,
                            inferenceAuthorizations,
                            authDebug,
                            stderr,
                        }),
                    );
                    for (const body of inferenceBodies) {
                        expect(body).toContain("First request.");
                        expect(body).toContain("First answer.");
                        expect(body).toContain("Continue.");
                    }
                    expect(resumedHistory).toContain(
                        '"type":"redacted_thinking","data":"synthetic-opaque-reasoning"',
                    );
                    // Claude Code 2.1.321 refreshes a rejected OAuth token once before any output,
                    // outside its retry budget, so a zero budget still recovers.
                    terminal.toMatchObject({ type: "done", state: "normal" });
                    expect(refreshBodies).toHaveLength(1);
                    expect(refreshBodies[0]).toContain("synthetic-original-refresh");
                    expect(inferenceAuthorizations).toEqual(
                        state === "expired"
                            ? ["Bearer synthetic-refreshed-access"]
                            : [
                                  "Bearer synthetic-original-access",
                                  "Bearer synthetic-refreshed-access",
                              ],
                    );
                    const updated = await readFile(original, "utf8");
                    expect(updated).toContain("synthetic-refreshed-access");
                    expect(updated).toContain("synthetic-rotated-refresh");
                    expect(childEnvironment?.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(selected);
                    expect(stagedPath).not.toBe(original);
                } finally {
                    session.destroy();
                    await Promise.all(exits);
                    tlsServer.closeAllConnections();
                    server.closeAllConnections();
                    await new Promise<void>((resolve) => server.close(() => resolve()));
                    await rm(root, { recursive: true, force: true });
                }
            },
        );
    },
);
