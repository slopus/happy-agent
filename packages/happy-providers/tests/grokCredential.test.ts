import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GrokSessionCredential } from "@/vendors/grok/GrokSessionCredential.js";
import { GROK_OAUTH_SCOPE } from "@/vendors/grok/impl/auth.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("Grok session credential", () => {
    it("refreshes an OIDC token after an unauthorized response", async () => {
        const issuer = await startOidcServer();
        const authFile = await writeAuthFile({ issuer });

        const credential = await GrokSessionCredential.tryLoad({ authFile });
        if (credential === null) throw new Error("Missing credential.");

        await expect(credential.refreshAfterUnauthorized()).resolves.toBe(true);
        expect(credential.credential.token).toBe("fresh-token");
    });

    it("refreshes an expired token before it is ever sent upstream", async () => {
        const issuer = await startOidcServer();
        const authFile = await writeAuthFile({
            expiresAt: "2026-07-24T05:58:51.837727Z",
            issuer,
        });

        const credential = await GrokSessionCredential.tryLoad({ authFile });
        if (credential === null) throw new Error("Missing credential.");
        expect(credential.credential.token).toBe("stale-token");

        await credential.ensureFresh({ now: Date.parse("2026-07-24T23:19:03.000Z") });

        expect(credential.credential.token).toBe("fresh-token");
    });

    it("refreshes a token that is about to expire within the safety buffer", async () => {
        const issuer = await startOidcServer();
        const authFile = await writeAuthFile({
            expiresAt: "2026-07-24T06:00:00.000Z",
            issuer,
        });

        const credential = await GrokSessionCredential.tryLoad({ authFile });
        if (credential === null) throw new Error("Missing credential.");

        await credential.ensureFresh({ now: Date.parse("2026-07-24T05:59:00.000Z") });

        expect(credential.credential.token).toBe("fresh-token");
    });

    it("leaves a valid token untouched and performs no refresh request", async () => {
        const issuer = await startOidcServer();
        const authFile = await writeAuthFile({
            expiresAt: "2026-07-25T00:00:00.000Z",
            issuer,
        });

        const credential = await GrokSessionCredential.tryLoad({ authFile });
        if (credential === null) throw new Error("Missing credential.");

        await credential.ensureFresh({ now: Date.parse("2026-07-24T12:00:00.000Z") });

        expect(credential.credential.token).toBe("stale-token");
        expect(issuer.tokenRequests).toBe(0);
    });

    it("persists a refreshed token without disturbing other stored scopes", async () => {
        const issuer = await startOidcServer();
        const authFile = await writeAuthFile({
            extraScopes: { "xai::api_key": { key: "unrelated-api-key" } },
            issuer,
        });

        const credential = await GrokSessionCredential.tryLoad({ authFile });
        if (credential === null) throw new Error("Missing credential.");
        await expect(credential.refreshAfterUnauthorized()).resolves.toBe(true);

        const stored = JSON.parse(await readFile(authFile, "utf8")) as Record<
            string,
            Record<string, unknown>
        >;
        expect(stored[GROK_OAUTH_SCOPE]?.key).toBe("fresh-token");
        expect(stored[GROK_OAUTH_SCOPE]?.refresh_token).toBe("fresh-refresh-token");
        expect(stored[GROK_OAUTH_SCOPE]?.oidc_issuer).toBe(issuer.origin);
        expect(stored["xai::api_key"]?.key).toBe("unrelated-api-key");

        const expiresAt = stored[GROK_OAUTH_SCOPE]?.expires_at;
        expect(typeof expiresAt).toBe("string");
        expect(Date.parse(expiresAt as string)).toBeGreaterThan(Date.now());

        // POSIX mode assertions do not describe Windows ACLs.
        if (process.platform !== "win32") {
            const mode = (await stat(authFile)).mode & 0o777;
            expect(mode).toBe(0o600);
        }
    });

    it("adopts a token another process already refreshed instead of spending the refresh token", async () => {
        const issuer = await startOidcServer();
        const authFile = await writeAuthFile({ issuer });
        await writeFile(
            authFile,
            JSON.stringify({
                [GROK_OAUTH_SCOPE]: {
                    key: "token-from-grok-cli",
                    refresh_token: "stale-refresh-token",
                    // Relative so the token stays unexpired whenever the suite runs.
                    expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
                    oidc_issuer: issuer.origin,
                    oidc_client_id: "grok-client",
                },
            }),
        );

        const credential = await GrokSessionCredential.tryLoad({ authFile });
        if (credential === null) throw new Error("Missing credential.");
        // tryLoad already sees the newer token here, so force the stale value back.
        credential.credential.token = "stale-token";

        await expect(credential.refreshAfterUnauthorized()).resolves.toBe(true);

        expect(credential.credential.token).toBe("token-from-grok-cli");
        expect(issuer.tokenRequests).toBe(0);
    });

    it("reports failure instead of throwing when the identity provider is unreachable", async () => {
        const authFile = await writeAuthFile({ issuer: await closedOrigin() });

        const credential = await GrokSessionCredential.tryLoad({ authFile });
        if (credential === null) throw new Error("Missing credential.");

        await expect(credential.refreshAfterUnauthorized()).resolves.toBe(false);
        await expect(
            credential.ensureFresh({ now: Date.parse("2026-07-24T23:19:03.000Z") }),
        ).resolves.toBeUndefined();
        expect(credential.credential.token).toBe("stale-token");
    });

    it("reports failure when the refresh token is rejected", async () => {
        const issuer = await startOidcServer({ rejectRefresh: true });
        const authFile = await writeAuthFile({ issuer });

        const credential = await GrokSessionCredential.tryLoad({ authFile });
        if (credential === null) throw new Error("Missing credential.");

        await expect(credential.refreshAfterUnauthorized()).resolves.toBe(false);
        expect(credential.credential.token).toBe("stale-token");
    });
});

interface OidcServer {
    origin: string;
    tokenRequests: number;
}

async function startOidcServer(options: { rejectRefresh?: boolean } = {}): Promise<OidcServer> {
    const state: OidcServer = { origin: "", tokenRequests: 0 };
    const server: Server = createServer((request, response) => {
        if (request.url === "/.well-known/openid-configuration") {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ token_endpoint: `${state.origin}/token` }));
            return;
        }
        if (request.url === "/token") {
            state.tokenRequests += 1;
            if (options.rejectRefresh === true) {
                response.writeHead(400, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: "invalid_grant" }));
                return;
            }
            response.setHeader("content-type", "application/json");
            response.end(
                JSON.stringify({
                    access_token: "fresh-token",
                    expires_in: 21_600,
                    refresh_token: "fresh-refresh-token",
                }),
            );
            return;
        }
        response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("Missing port.");
    state.origin = `http://127.0.0.1:${address.port}`;
    cleanups.push(async () => {
        server.close();
        server.closeAllConnections();
    });
    return state;
}

/** Binds an ephemeral port and releases it so connections are refused. */
async function closedOrigin(): Promise<OidcServer> {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("Missing port.");
    const origin = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return { origin, tokenRequests: 0 };
}

async function writeAuthFile(options: {
    expiresAt?: string;
    extraScopes?: Record<string, Record<string, unknown>>;
    issuer: OidcServer;
}): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "rig-grok-auth-"));
    cleanups.push(async () => {
        await rm(directory, { force: true, recursive: true });
    });
    const authFile = join(directory, "auth.json");
    await writeFile(
        authFile,
        JSON.stringify({
            ...options.extraScopes,
            [GROK_OAUTH_SCOPE]: {
                key: "stale-token",
                refresh_token: "stale-refresh-token",
                ...(options.expiresAt === undefined ? {} : { expires_at: options.expiresAt }),
                oidc_issuer: options.issuer.origin,
                oidc_client_id: "grok-client",
            },
        }),
    );
    return authFile;
}
