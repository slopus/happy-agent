import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import {
    HappyAgentApiError,
    HappyAgentClient,
    type Cloud,
    type CloudAuthorizing,
    type CloudConnected,
    type CloudDisconnected,
} from "@slopus/happy-agent-client";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiModule } from "../../sources/api/ApiModule.js";
import {
    CloudModule,
    CloudOperationError,
    type CloudUpdatedListener,
} from "../../sources/cloud/CloudModule.js";
import { createCloudDatabase } from "../../sources/cloud/CloudDatabase.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const workos = vi.hoisted(() => ({
    authorization: vi.fn(),
    create: vi.fn(),
    exchange: vi.fn(),
    refresh: vi.fn(),
}));

vi.mock("@workos-inc/node", async (importOriginal) => {
    const original = await importOriginal<typeof import("@workos-inc/node")>();
    return {
        ...original,
        WorkOS: class {
            readonly userManagement = {
                authenticateWithCode: workos.exchange,
                authenticateWithRefreshToken: workos.refresh,
                getAuthorizationUrlWithPKCE: workos.authorization,
            };

            constructor(options: unknown) {
                workos.create(options);
            }

            createHttpClient(): object {
                return {};
            }
        },
    };
});

const VERSION_1 = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const VERSION_2 = "01991f3a-5c1e-7001-8000-2f9a1b3c4d5e";
const VERSION_3 = "01991f3a-5c1e-7002-8000-2f9a1b3c4d5e";

const user = {
    email: "person@example.com",
    firstName: "Ada",
    id: "user_01H",
    lastName: "Lovelace",
};

const disconnected: CloudDisconnected = {
    authorization: null,
    environment: null,
    error: null,
    status: "disconnected",
    updatedAt: 1,
    user: null,
    version: VERSION_1,
};
const authorizing: CloudAuthorizing = {
    authorization: { expiresAt: 10_000, url: "https://api.workos.example/authorize" },
    environment: "production",
    error: null,
    status: "authorizing",
    updatedAt: 2,
    user: null,
    version: VERSION_2,
};
const connected: CloudConnected = {
    authorization: null,
    environment: "production",
    error: null,
    status: "connected",
    updatedAt: 3,
    user,
    version: VERSION_3,
};

const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
    workos.authorization.mockReset().mockResolvedValue({
        codeVerifier: `verifier-${"x".repeat(42)}`,
        state: `state-${"x".repeat(16)}`,
        url: "https://api.workos.example/authorize",
    });
    workos.exchange.mockReset().mockResolvedValue({
        accessToken: "access-a",
        refreshToken: "refresh-a",
        user,
    });
    workos.refresh.mockReset().mockResolvedValue({
        accessToken: "access-b",
        refreshToken: "refresh-b",
        user,
    });
    workos.create.mockReset();
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ message: "hello", userId: user.id })),
    );
});

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.unstubAllGlobals();
});

describe("Cloud HTTP API", () => {
    it("carries every client operation through the API and echoes mutation events", async () => {
        const fixture = await apiFixture();
        const before = fixture.api.cursor();

        await expect(fixture.client.getCloud()).resolves.toEqual({ cloud: disconnected });
        await expect(
            fixture.client.startCloudAuthorization({
                environment: "production",
                mutationId: "cloud-start-1",
                redirectUri: "desktop-app://workos/callback",
            }),
        ).resolves.toEqual({ cloud: authorizing });
        await expect(
            fixture.client.completeCloudAuthorization({
                callbackUrl: "desktop-app://workos/callback?code=code&state=state",
                mutationId: "cloud-complete-1",
            }),
        ).resolves.toEqual({ cloud: connected });
        await expect(
            fixture.client.mintCloudAccessToken({ mutationId: "cloud-mint-1" }),
        ).resolves.toEqual({ accessToken: "access-token", cloud: connected });

        const events = await fixture.client.getEvents({ after: before });
        expect(events.events).toEqual([
            expect.objectContaining({
                payload: { cloud: authorizing, mutationId: "cloud-start-1" },
                type: "cloud.updated",
            }),
            expect.objectContaining({
                payload: { cloud: connected, mutationId: "cloud-complete-1" },
                type: "cloud.updated",
            }),
        ]);
        expect(JSON.stringify(events)).not.toContain("access-token");

        await expect(
            fixture.client.disconnectCloud({ mutationId: "cloud-disconnect-1" }),
        ).resolves.toEqual({ cloud: disconnected });
        expect(fixture.cloud.start).toHaveBeenCalledWith(
            fixture.context,
            expect.objectContaining({ redirectUri: "desktop-app://workos/callback" }),
        );
    });

    it("returns an authoritative Cloud snapshot when minting discovers revocation", async () => {
        const revoked: CloudDisconnected = {
            ...disconnected,
            error: { code: "credentials_rejected", message: "Cloud authorization has expired." },
            updatedAt: 4,
            version: "01991f3a-5c1e-7003-8000-2f9a1b3c4d5e",
        };
        const fixture = await apiFixture(connected);
        fixture.cloud.mint.mockRejectedValueOnce(
            new CloudOperationError(
                409,
                "cloud_unauthorized",
                "Cloud authorization has expired.",
                revoked,
            ),
        );

        const error = await fixture.client
            .mintCloudAccessToken()
            .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(HappyAgentApiError);
        expect(error).toMatchObject({
            body: { cloud: revoked, code: "cloud_unauthorized" },
            code: "cloud_unauthorized",
            status: 409,
        });
    });

    it("accepts a genuinely empty chunked body for optional Cloud mutations", async () => {
        const fixture = await apiFixture(connected);
        const response = await apiFetch(fixture.api, fixture.context)(
            "http://happy-agent.test/v0/cloud/auth",
            {
                headers: {
                    authorization: `Bearer ${fixture.token}`,
                    "transfer-encoding": "chunked",
                },
                method: "DELETE",
            },
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ cloud: disconnected });
        expect(fixture.cloud.disconnect).toHaveBeenCalledTimes(1);
    });

    it("carries the real Cloud module through completion, minting, and API events", async () => {
        const fixture = await actualCloudApiFixture();
        const before = fixture.api.cursor();

        const authorizing = await fixture.client.startCloudAuthorization({
            environment: "production",
            mutationId: "cloud-real-start",
            redirectUri: "happy-auth://callback",
        });
        expect(authorizing.cloud.status).toBe("authorizing");
        const completed = await fixture.client.completeCloudAuthorization({
            callbackUrl: `happy-auth://callback?code=code-a&state=${encodeURIComponent(`state-${"x".repeat(16)}`)}`,
            mutationId: "cloud-real-complete",
        });
        expect(completed.cloud).toMatchObject({ status: "connected", user });

        const minted = await fixture.client.mintCloudAccessToken({
            mutationId: "cloud-real-mint",
        });
        expect(minted).toMatchObject({ accessToken: "access-b", cloud: completed.cloud });
        expect((await createCloudDatabase().read(fixture.context))?.session?.refreshToken).toBe(
            "refresh-b",
        );

        const events = await fixture.client.getEvents({ after: before });
        expect(events.events).toEqual([
            expect.objectContaining({
                payload: { cloud: authorizing.cloud, mutationId: "cloud-real-start" },
                type: "cloud.updated",
            }),
            expect.objectContaining({
                payload: { cloud: completed.cloud, mutationId: "cloud-real-complete" },
                type: "cloud.updated",
            }),
        ]);
        expect(JSON.stringify(events)).not.toContain("access-a");
        expect(JSON.stringify(events)).not.toContain("access-b");
        expect(JSON.stringify(events)).not.toContain("refresh-a");
        expect(JSON.stringify(events)).not.toContain("refresh-b");
    });
});

async function apiFixture(initial: Cloud = disconnected) {
    const directory = await mkdtemp(join(tmpdir(), "happy-cloud-api-"));
    const context = createRootContext().named("cloud-api-test");
    let current = initial;
    let updated: CloudUpdatedListener | undefined;
    const cloud = {
        complete: vi.fn(async (ctx: Context) => {
            current = connected;
            updated?.(ctx, current);
            return connected;
        }),
        disconnect: vi.fn(async (ctx: Context) => {
            current = disconnected;
            updated?.(ctx, current);
            return disconnected;
        }),
        mint: vi.fn(async () => ({ accessToken: "access-token", cloud: connected })),
        onUpdated: vi.fn((listener: CloudUpdatedListener) => {
            updated = listener;
            return () => {
                updated = undefined;
            };
        }),
        start: vi.fn(async (ctx: Context) => {
            current = authorizing;
            updated?.(ctx, current);
            return authorizing;
        }),
        status: vi.fn(() => current),
    };
    const subscriptions = new Proxy(
        {},
        {
            get: () => () => () => undefined,
        },
    );
    const config = {
        configuration: {
            paths: {
                agentHome: directory,
                tokenPath: join(directory, "api-token"),
            },
        },
    };
    const api = createApi(cloud, config, subscriptions);
    await api.beforeStart(context, {} as never);
    await api.markReady();
    const token = api.token();
    if (token === undefined) throw new Error("The API fixture did not create a token.");
    const client = new HappyAgentClient({
        endpoint: "http://happy-agent.test",
        fetch: apiFetch(api, context),
        token,
    });
    cleanups.push(async () => {
        await api.close();
        await rm(directory, { force: true, recursive: true });
    });
    return { api, client, cloud, context, token };
}

async function actualCloudApiFixture() {
    const directory = await mkdtemp(join(tmpdir(), "happy-cloud-api-real-"));
    const cloud = new CloudModule();
    const database = moduleDatabase(cloud.migrations, "cloud-api-real");
    await database.ready;
    await cloud.beforeStart(database.context, {} as never);
    const subscriptions = new Proxy(
        {},
        {
            get: () => () => () => undefined,
        },
    );
    const config = {
        configuration: {
            paths: {
                agentHome: directory,
                tokenPath: join(directory, "api-token"),
            },
        },
    };
    const api = createApi(cloud, config, subscriptions);
    await api.beforeStart(database.context, {} as never);
    await api.markReady();
    const token = api.token();
    if (token === undefined) throw new Error("The API fixture did not create a token.");
    const client = new HappyAgentClient({
        endpoint: "http://happy-agent.test",
        fetch: apiFetch(api, database.context),
        token,
    });
    cleanups.push(async () => {
        await api.close();
        await cloud.stop();
        database.close();
        await rm(directory, { force: true, recursive: true });
    });
    return { api, client, cloud, context: database.context, token };
}

function createApi(cloud: unknown, config: unknown, subscriptions: unknown): ApiModule {
    return new ApiModule(
        subscriptions as never,
        config as never,
        subscriptions as never,
        cloud as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
    );
}

function apiFetch(api: ApiModule, context: Context): typeof fetch {
    return async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const headers = new Headers(init?.headers);
        const body = typeof init?.body === "string" ? init.body : undefined;
        const request = Readable.from(
            body === undefined ? [] : [Buffer.from(body)],
        ) as IncomingMessage;
        Object.assign(request, {
            headers: Object.fromEntries(headers.entries()),
            method: init?.method ?? "GET",
            url: `${url.pathname}${url.search}`,
        });

        let responseBody = "";
        let responseStatus = 200;
        const responseHeaders = new Headers();
        const response = {
            end(value?: string | Buffer) {
                responseBody = value?.toString() ?? "";
            },
            setHeader(name: string, value: number | string | readonly string[]) {
                responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : String(value));
            },
            writeHead(status: number, values?: Record<string, number | string>) {
                responseStatus = status;
                for (const [name, value] of Object.entries(values ?? {})) {
                    responseHeaders.set(name, String(value));
                }
                return this;
            },
        } as unknown as ServerResponse;
        await api.handleRequest(context, request, response);
        return new Response(responseBody, {
            headers: responseHeaders,
            status: responseStatus,
        });
    };
}
