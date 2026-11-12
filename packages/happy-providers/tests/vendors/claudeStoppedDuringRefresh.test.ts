import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { ClaudeCodeCredential } from "@/vendors/claude/ClaudeCodeCredential.js";
import { ClaudeSession } from "@/vendors/claude/ClaudeSession.js";
import { testContext } from "../testContext.js";

const run = promisify(execFile);

// Claude Code renews a stored sign-in by spending the refresh token at the token endpoint and then
// saving the new pair. Stopping the session in between, as a steer or an abort does, must not lose
// that pair: the spent token left behind is refused on the next renewal, and Claude Code then
// clears the sign-in shared by every session on the account.
describe.skipIf(process.platform === "win32")("Claude session stopped during a renewal", () => {
    const cleanups: (() => Promise<void>)[] = [];

    afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    it("keeps the renewed sign-in when the session stops before the token answer", async () => {
        const root = await mkdtemp(join(tmpdir(), "claude-stopped-renewal-"));
        cleanups.push(async () => await rm(root, { recursive: true, force: true }));
        const configDir = join(root, "config");
        await mkdir(configDir);
        const keychainService = `Claude Code-credentials-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
        if (process.platform === "darwin") {
            cleanups.push(async () => {
                await run("security", ["delete-generic-password", "-s", keychainService]).catch(
                    () => undefined,
                );
            });
        }
        await writeFile(
            join(configDir, ".credentials.json"),
            JSON.stringify({
                claudeAiOauth: {
                    accessToken: "stored-access",
                    refreshToken: "stored-refresh",
                    // Inside Claude Code's five-minute renewal window, so the first request renews.
                    expiresAt: Date.now() + 60_000,
                    scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
                    subscriptionType: "max",
                },
            }),
        );
        const certificates = await createCertificates(join(root, "tls"));
        const credential = await ClaudeCodeCredential.tryLoad({ configDir, env: {} });
        if (credential === null) throw new Error("Missing synthetic native credential.");

        let session: ClaudeSession | undefined;
        const presented: string[] = [];
        let answered: () => void = () => {};
        const answer = new Promise<void>((resolve) => {
            answered = resolve;
        });
        const tokens = createHttpsServer(certificates, async (request, response) => {
            const body = JSON.parse(await readBody(request)) as { refresh_token?: string };
            presented.push(body.refresh_token ?? "");
            if (body.refresh_token !== "stored-refresh") {
                response.writeHead(400, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: "invalid_grant" }));
                return;
            }
            // The server has spent the token. The session stops now, and the answer arrives
            // after the SDK's two-second grace, as it does from a slow token endpoint.
            session?.destroy();
            await new Promise((resolve) => setTimeout(resolve, 4_000));
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    token_type: "Bearer",
                    access_token: "renewed-access",
                    refresh_token: "renewed-refresh",
                    expires_in: 28_800,
                    scope: "user:inference user:profile user:sessions:claude_code",
                }),
            );
            answered();
        });
        await listen(tokens);
        cleanups.push(async () => await close(tokens));
        const api = createServer(async (request, response) => {
            await readBody(request);
            response.writeHead(401, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    type: "error",
                    error: { type: "authentication_error", message: "Unexpected request." },
                }),
            );
        });
        const apiPort = await listen(api);
        cleanups.push(async () => await close(api));
        // Only the token endpoint is reachable, through this proxy; everything else is refused.
        const tunnels: Socket[] = [];
        const proxy = createServer((_, response) => {
            response.writeHead(403);
            response.end();
        }).on("connect", (request, socket: Socket) => {
            // A stopped child may drop its end of the tunnel at any moment.
            socket.on("error", () => undefined);
            tunnels.push(socket);
            if (request.url !== "platform.claude.com:443") {
                socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
                return;
            }
            const upstream = connect(port(tokens), "127.0.0.1", () => {
                socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                upstream.pipe(socket);
                socket.pipe(upstream);
            });
            upstream.on("error", () => undefined);
            tunnels.push(upstream);
        });
        const proxyPort = await listen(proxy);
        cleanups.push(async () => {
            for (const socket of tunnels) socket.destroy();
            await close(proxy);
        });

        session = new ClaudeSession("stopped-renewal", {
            credential,
            cwd: root,
            instructions: "",
            model: "opus[1m]",
            inferenceMaxRetries: 0,
            tools: [],
            env: {
                PATH: process.env.PATH,
                // The real home, so a macOS child reaches the login keychain it saves the renewal to.
                HOME: process.env.HOME,
                TMPDIR: root,
                CLAUDE_CODE_TMPDIR: root,
                ANTHROPIC_BASE_URL: `http://127.0.0.1:${apiPort}`,
                HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
                HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
                NO_PROXY: "127.0.0.1",
                NODE_EXTRA_CA_CERTS: certificates.caPath,
            },
        });
        cleanups.push(async () => session?.destroy());

        for await (const _ of session.run(testContext, {
            context: {
                instructions: "",
                messages: [{ role: "user", content: [{ type: "text", text: "Hello." }] }],
            },
        })) {
            // The run ends when the session stops.
        }
        await answer;

        await expect
            .poll(async () => await storedRefreshToken(configDir, keychainService), {
                timeout: 15_000,
                interval: 250,
            })
            .toBe("renewed-refresh");
        expect(presented).toEqual(["stored-refresh"]);
    }, 60_000);
});

async function storedRefreshToken(configDir: string, keychainService: string): Promise<string> {
    const sources: (() => Promise<string>)[] = [
        async () =>
            (await run("security", ["find-generic-password", "-w", "-s", keychainService])).stdout,
        async () => await readFile(join(configDir, ".credentials.json"), "utf8"),
    ];
    for (const source of process.platform === "darwin" ? sources : sources.slice(1)) {
        try {
            const stored = JSON.parse(await source()) as {
                claudeAiOauth?: { refreshToken?: string };
            };
            const token = stored.claudeAiOauth?.refreshToken;
            if (token) return token;
        } catch {
            // Not stored in this place.
        }
    }
    return "";
}

async function createCertificates(
    directory: string,
): Promise<{ key: Buffer; cert: Buffer; caPath: string }> {
    await mkdir(directory);
    const file = (name: string) => join(directory, name);
    await writeFile(
        file("leaf.cnf"),
        "[ext]\nsubjectAltName=DNS:platform.claude.com\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n",
    );
    await run("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "2",
        "-subj",
        "/CN=Happy test CA",
        "-keyout",
        file("ca.key"),
        "-out",
        file("ca.pem"),
    ]);
    await run("openssl", [
        "req",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-subj",
        "/CN=platform.claude.com",
        "-keyout",
        file("leaf.key"),
        "-out",
        file("leaf.csr"),
    ]);
    await run("openssl", [
        "x509",
        "-req",
        "-days",
        "2",
        "-in",
        file("leaf.csr"),
        "-CA",
        file("ca.pem"),
        "-CAkey",
        file("ca.key"),
        "-CAcreateserial",
        "-extfile",
        file("leaf.cnf"),
        "-extensions",
        "ext",
        "-out",
        file("leaf.pem"),
    ]);
    return {
        key: await readFile(file("leaf.key")),
        cert: await readFile(file("leaf.pem")),
        caPath: file("ca.pem"),
    };
}

async function readBody(request: IncomingMessage): Promise<string> {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    return body;
}

function port(server: { address(): unknown }): number {
    const address = server.address();
    if (address === null || typeof address !== "object" || !("port" in address)) {
        throw new Error("Missing server port.");
    }
    return Number(address.port);
}

async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    return port(server);
}

async function close(server: Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
}
