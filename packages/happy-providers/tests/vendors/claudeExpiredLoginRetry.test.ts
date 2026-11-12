import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SessionEvent } from "@/core/SessionEvent.js";
import { ClaudeCodeCredential } from "@/vendors/claude/ClaudeCodeCredential.js";
import { ClaudeSession } from "@/vendors/claude/ClaudeSession.js";
import { testContext } from "../testContext.js";

// The real SDK child runs against a stored login whose access token has expired. Its refresh
// cannot reach the token endpoint, so every request is refused with a 401 until the retries run
// out. While it retries, the session must say a sign-in is failing, never that Claude is busy.
describe.skipIf(process.platform === "win32")("Claude expired native login", () => {
    const cleanups: (() => Promise<void>)[] = [];

    afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    it("retries a refused login as an authentication failure", async () => {
        const root = await mkdtemp(join(tmpdir(), "claude-expired-login-"));
        cleanups.push(async () => await rm(root, { recursive: true, force: true }));
        const configDir = join(root, "config");
        await mkdir(configDir);
        const stored = JSON.stringify({
            claudeAiOauth: {
                accessToken: "synthetic-expired-access",
                refreshToken: "synthetic-refresh",
                expiresAt: Date.now() - 60_000,
                scopes: ["user:inference", "user:profile"],
                subscriptionType: "max",
            },
        });
        await writeFile(join(configDir, ".credentials.json"), stored);
        const credential = await ClaudeCodeCredential.tryLoad({ configDir, env: {} });
        if (credential === null) throw new Error("Missing synthetic native credential.");

        const authorizations: string[] = [];
        const api = await listen(
            createServer(async (request, response) => {
                for await (const _ of request) {
                    // Drain the request before answering.
                }
                authorizations.push(request.headers.authorization ?? "");
                response.writeHead(401, { "content-type": "application/json" });
                response.end(
                    JSON.stringify({
                        type: "error",
                        error: {
                            type: "authentication_error",
                            message:
                                "OAuth token has expired. Please obtain a new token or refresh your existing token.",
                        },
                    }),
                );
            }),
        );
        cleanups.push(async () => await close(api.server));
        // Every host other than the local API goes through this proxy, which refuses it, so the
        // token refresh fails the way an unreachable token endpoint does.
        const refusedHosts: string[] = [];
        const proxy = await listen(
            createServer((_, response) => {
                response.writeHead(403);
                response.end();
            }).on("connect", (request, socket: Socket) => {
                refusedHosts.push(request.url ?? "");
                socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
            }),
        );
        cleanups.push(async () => await close(proxy.server));

        const session = new ClaudeSession("expired-login", {
            credential,
            cwd: root,
            instructions: "",
            model: "opus[1m]",
            inferenceMaxRetries: 2,
            tools: [],
            env: {
                PATH: process.env.PATH,
                HOME: root,
                TMPDIR: root,
                CLAUDE_CODE_TMPDIR: root,
                ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`,
                HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
                HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
                NO_PROXY: "127.0.0.1",
                CLAUDE_CODE_OAUTH_401_WAIT_MS: "0",
            },
        });
        cleanups.push(async () => session.destroy());

        const events: SessionEvent[] = [];
        for await (const event of session.run(testContext, {
            context: {
                instructions: "",
                messages: [{ role: "user", content: [{ type: "text", text: "Hello." }] }],
            },
        })) {
            events.push(event);
        }

        expect(refusedHosts).toContain("platform.claude.com:443");
        expect(authorizations.length).toBeGreaterThan(1);
        expect(new Set(authorizations)).toEqual(new Set(["Bearer synthetic-expired-access"]));
        const retries = events.filter((event) => event.type === "retrying");
        expect(retries).toHaveLength(2);
        for (const retry of retries) {
            expect(retry).toMatchObject({
                providerError: {
                    type: "authentication",
                    diagnostics: { code: "authentication_failed", status: 401 },
                },
            });
        }
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            providerError: { type: "authentication" },
        });
        // A refresh that never happened leaves the stored login exactly as it was.
        expect(await readFile(join(configDir, ".credentials.json"), "utf8")).toBe(stored);
    }, 60_000);
});

async function listen(server: Server): Promise<{ server: Server; port: number }> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server port.");
    return { server, port: address.port };
}

async function close(server: Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
}
