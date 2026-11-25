import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexSessionCredential } from "@/vendors/codex/CodexSessionCredential.js";
import { CodexCredentialRefreshError } from "@/vendors/codex/errors/codexErrors.js";
import { GrokSessionCredential } from "@/vendors/grok/GrokSessionCredential.js";
import { GROK_OAUTH_SCOPE } from "@/vendors/grok/impl/auth.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    vi.useRealTimers();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("credential maintenance without inference", () => {
    for (const vendor of ["codex", "grok"] as const) {
        it(`${vendor}: shares rotation across credential instances and inference recovery`, async () => {
            const fixture = await setup(vendor);
            const first = await fixture.load();
            const second = await fixture.load();
            const maintenance = first.refreshForMaintenance();
            await fixture.requested;
            const recovery =
                second instanceof CodexSessionCredential
                    ? second.refreshForUnauthorized()
                    : second.refreshAfterUnauthorized();
            fixture.release();
            expect(await maintenance).toBeTruthy();
            expect(await recovery).toBeTruthy();
            expect(fixture.requests()).toBe(1);
            const persisted = await readFile(fixture.authFile, "utf8");
            expect(persisted).toContain("fresh-access");
            expect(persisted).toContain("fresh-refresh");
            expect(persisted).toContain("unrelated");
        });

        it(`${vendor}: cancellation stops waiting without discarding a rotated token`, async () => {
            const fixture = await setup(vendor);
            const credential = await fixture.load();
            const controller = new AbortController();
            const maintenance = credential.refreshForMaintenance({ signal: controller.signal });
            await fixture.requested;
            const assertion = expect(maintenance).rejects.toThrow("Cancelled maintenance");
            controller.abort(new Error("Cancelled maintenance"));
            await assertion;
            const joining = credential.refreshForMaintenance();
            fixture.release();
            expect(await joining).toBeTruthy();
            expect(fixture.requests()).toBe(1);
            expect(await readFile(fixture.authFile, "utf8")).toContain("fresh-refresh");
        });

        it(`${vendor}: does not start an already-cancelled refresh`, async () => {
            const fixture = await setup(vendor);
            const credential = await fixture.load();
            await expect(
                credential.refreshForMaintenance({
                    signal: AbortSignal.abort(new Error("Cancelled maintenance")),
                }),
            ).rejects.toThrow("Cancelled maintenance");
            expect(fixture.requests()).toBe(0);
        });

        it(`${vendor}: bounds a stalled response body and permits a later refresh`, async () => {
            const fixture = await setup(vendor);
            const credential = await fixture.load();
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            const result = credential.refreshForMaintenance().catch(() => false);
            await fixture.requested;
            await vi.advanceTimersByTimeAsync(30_001);
            expect(await result).toBeFalsy();
            vi.useRealTimers();
            fixture.release();
            expect(await credential.refreshForMaintenance()).toBeTruthy();
            expect(fixture.requests()).toBe(2);
        });

        it(`${vendor}: does not restore a credential file deleted before refresh`, async () => {
            const fixture = await setup(vendor);
            const credential = await fixture.load();
            await rm(fixture.authFile);
            expect(await credential.refreshForMaintenance()).toBeFalsy();
            expect(fixture.requests()).toBe(0);
            await expect(readFile(fixture.authFile)).rejects.toMatchObject({ code: "ENOENT" });
        });

        it(`${vendor}: does not overwrite a login changed during the exchange`, async () => {
            const fixture = await setup(vendor);
            const credential = await fixture.load();
            const result = credential.refreshForMaintenance().catch(() => false);
            await fixture.requested;
            const replacement = (await readFile(fixture.authFile, "utf8")).replaceAll(
                "stale-",
                "another-",
            );
            await writeFile(fixture.authFile, replacement);
            fixture.release();
            // Codex may adopt another owner's replacement for this same known account,
            // but neither provider may overwrite it with its own losing exchange.
            expect(Boolean(await result)).toBe(vendor === "codex");
            expect(await readFile(fixture.authFile, "utf8")).toBe(replacement);
        });

        it(`${vendor}: rejects oversized token responses without changing the login`, async () => {
            const fixture = await setup(vendor, {
                body: JSON.stringify({ access_token: "x".repeat(300_000) }),
            });
            const credential = await fixture.load();
            const previous = await readFile(fixture.authFile, "utf8");
            fixture.release();
            expect(await credential.refreshForMaintenance().catch(() => false)).toBeFalsy();
            expect(await readFile(fixture.authFile, "utf8")).toBe(previous);
        });

        it.skipIf(process.platform === "win32")(
            `${vendor}: shares refreshes through symlink aliases`,
            async () => {
                const fixture = await setup(vendor);
                const alias = `${fixture.authFile}.alias`;
                await symlink(fixture.authFile, alias);
                const first = await fixture.load();
                const second = await fixture.load(alias);
                const one = first.refreshForMaintenance();
                await fixture.requested;
                const two = second.refreshForMaintenance();
                fixture.release();
                expect(await one).toBeTruthy();
                expect(await two).toBeTruthy();
                expect(fixture.requests()).toBe(1);
                expect(await readFile(alias, "utf8")).toBe(
                    await readFile(fixture.authFile, "utf8"),
                );
            },
        );
    }
});

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

describe("Codex maintenance policy", () => {
    it.each([
        { case: "a healthy login", expiresIn: 10 * DAY, lastRefresh: -DAY, requests: 0 },
        {
            case: "a token expiring before the next pass",
            expiresIn: HOUR,
            lastRefresh: -DAY,
            requests: 1,
        },
        {
            case: "a login renewed over eight days ago",
            expiresIn: 10 * DAY,
            lastRefresh: -9 * DAY,
            requests: 1,
        },
        {
            case: "a login with no renewal time",
            expiresIn: 10 * DAY,
            lastRefresh: undefined,
            requests: 1,
        },
    ])("renews $case only when it is due", async ({ expiresIn, lastRefresh, requests }) => {
        const fixture = await codexFixture(() => tokenResponse());
        await fixture.write({ expiresIn, lastRefresh });
        const before = await readFile(fixture.authFile, "utf8");
        const credential = await fixture.load();
        expect(await credential.refreshForMaintenance()).toBeTruthy();
        expect(fixture.requests()).toBe(requests);
        if (requests === 0) expect(await readFile(fixture.authFile, "utf8")).toBe(before);
        else expect(await readFile(fixture.authFile, "utf8")).toContain("fresh-refresh");
    });

    it("still renews a healthy login on demand after an unauthorized response", async () => {
        const fixture = await codexFixture(() => tokenResponse());
        await fixture.write({ expiresIn: 10 * DAY, lastRefresh: -DAY });
        const credential = await fixture.load();
        expect(await credential.refreshForUnauthorized()).toBeTruthy();
        expect(fixture.requests()).toBe(1);
    });

    it.each([
        {
            status: 401,
            body: { error: { code: "refresh_token_reused", message: "secret-free-text" } },
            code: "refresh_token_reused",
            permanent: true,
        },
        {
            status: 400,
            body: { error: "invalid_grant", error_description: "secret-free-text" },
            code: "invalid_grant",
            permanent: true,
        },
        {
            status: 400,
            body: { error: { code: "refresh_token_expired" } },
            code: "refresh_token_expired",
            permanent: true,
        },
        { status: 401, body: { error: { message: "secret-free-text" } }, permanent: true },
        {
            status: 503,
            body: { code: "server_is_overloaded" },
            code: "server_is_overloaded",
            permanent: false,
        },
        { status: 400, body: { error: "secret free text, not a code" }, permanent: false },
        { status: 502, body: "<html>secret-free-text</html>", permanent: false },
    ])(
        "keeps HTTP $status and only a safe OAuth code from a failed refresh",
        async ({ status, body, code, permanent }) => {
            const fixture = await codexFixture(() =>
                typeof body === "string"
                    ? new Response(body, { status })
                    : Response.json(body, { status }),
            );
            await fixture.write({});
            const credential = await fixture.load();
            const failure = await credential
                .refreshForMaintenance()
                .catch((error: unknown) => error);
            expect(failure).toBeInstanceOf(CodexCredentialRefreshError);
            expect(failure).toMatchObject({ status, code, permanent });
            expect(JSON.stringify(failure)).not.toContain("secret");
            expect(String(failure)).not.toContain("secret");
            expect(String(failure)).toContain(`HTTP ${status}`);
        },
    );

    it("stops renewing a rejected login until its auth file changes", async () => {
        const fixture = await codexFixture(() =>
            Response.json({ error: { code: "refresh_token_reused" } }, { status: 401 }),
        );
        await fixture.write({});
        const credential = await fixture.load();
        await expect(credential.refreshForMaintenance()).rejects.toMatchObject({ permanent: true });
        await expect(credential.refreshForMaintenance()).rejects.toMatchObject({
            code: "refresh_token_reused",
        });
        expect(fixture.requests()).toBe(1);
        // Recovery after a 401 is on demand and still asks.
        await expect(credential.refreshForUnauthorized()).rejects.toMatchObject({
            permanent: true,
        });
        expect(fixture.requests()).toBe(2);
        // A new sign-in writes a new file, which maintenance tries again.
        await fixture.write({ refreshToken: "signed-in-again" });
        await expect(credential.refreshForMaintenance()).rejects.toMatchObject({ permanent: true });
        expect(fixture.requests()).toBe(3);
    });

    it("keeps retrying a transient failure on every pass", async () => {
        const fixture = await codexFixture(() =>
            Response.json({ error: { code: "server_error" } }, { status: 500 }),
        );
        await fixture.write({});
        const credential = await fixture.load();
        await expect(credential.refreshForMaintenance()).rejects.toMatchObject({
            permanent: false,
        });
        await expect(credential.refreshForMaintenance()).rejects.toMatchObject({
            permanent: false,
        });
        expect(fixture.requests()).toBe(2);
    });
});

function tokenResponse() {
    return Response.json({ access_token: "fresh-access", refresh_token: "fresh-refresh" });
}

async function codexFixture(respond: () => Response) {
    const directory = await mkdtemp(join(tmpdir(), "happy-codex-maintenance-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const authFile = join(directory, "auth.json");
    let requests = 0;
    const server = createServer(async (request, reply) => {
        for await (const _chunk of request) {
            /* Drain the real token request. */
        }
        requests++;
        const response = respond();
        reply.writeHead(response.status, Object.fromEntries(response.headers));
        reply.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port.");
    const tokenUrl = `http://127.0.0.1:${address.port}/token`;
    return {
        authFile,
        requests: () => requests,
        write: async (options: {
            expiresIn?: number;
            lastRefresh?: number | undefined;
            refreshToken?: string;
        }) => {
            const now = Date.now();
            const claims = { exp: Math.floor((now + (options.expiresIn ?? 10 * DAY)) / 1_000) };
            const accessToken = [{ alg: "none" }, claims, "signature"]
                .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
                .join(".");
            await writeFile(
                authFile,
                JSON.stringify({
                    tokens: {
                        access_token: accessToken,
                        refresh_token: options.refreshToken ?? "stale-refresh",
                        account_id: "account",
                    },
                    ...(options.lastRefresh === undefined
                        ? {}
                        : { last_refresh: new Date(now + options.lastRefresh).toISOString() }),
                }),
            );
        },
        load: async () => {
            const credential = await CodexSessionCredential.tryLoad({
                authFile,
                env: { CODEX_REFRESH_TOKEN_URL_OVERRIDE: tokenUrl },
            });
            if (credential === null) throw new Error("Missing fixture credential.");
            return credential;
        },
    };
}

async function setup(vendor: "codex" | "grok", options: { body?: string } = {}) {
    const directory = await mkdtemp(join(tmpdir(), "happy-credential-maintenance-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const authFile = join(directory, "auth.json");
    let requests = 0;
    const requested = deferred();
    const release = deferred();
    const server = createServer(async (request, response) => {
        for await (const _chunk of request) {
            /* Drain the real HTTP request. */
        }
        if (request.url === "/.well-known/openid-configuration") {
            response.end(JSON.stringify({ token_endpoint: `${origin}/token` }));
            return;
        }
        requests++;
        response.writeHead(200, { "content-type": "application/json" });
        response.flushHeaders();
        requested.resolve();
        await release.promise;
        response.end(
            options.body ??
                JSON.stringify({
                    access_token: "fresh-access",
                    refresh_token: "fresh-refresh",
                    expires_in: 21_600,
                }),
        );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
        release.resolve();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port.");
    const origin = `http://127.0.0.1:${address.port}`;
    await writeFile(
        authFile,
        JSON.stringify(
            vendor === "codex"
                ? {
                      unrelated: "preserve-me",
                      tokens: {
                          access_token: "stale-access",
                          refresh_token: "stale-refresh",
                          account_id: "account",
                      },
                  }
                : {
                      unrelated: { key: "preserve-me" },
                      [GROK_OAUTH_SCOPE]: {
                          key: "stale-access",
                          refresh_token: "stale-refresh",
                          oidc_issuer: origin,
                          oidc_client_id: "test-client",
                          expires_at: new Date(Date.now() + 60_000).toISOString(),
                      },
                  },
        ),
    );
    return {
        authFile,
        requested: requested.promise,
        release: () => release.resolve(),
        requests: () => requests,
        load: async (path = authFile) => {
            const credential =
                vendor === "codex"
                    ? await CodexSessionCredential.tryLoad({
                          authFile: path,
                          env: { CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${origin}/token` },
                      })
                    : await GrokSessionCredential.tryLoad({ authFile: path, env: {} });
            if (credential === null) throw new Error("Missing fixture credential.");
            return credential;
        },
    };
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
