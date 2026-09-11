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
import { ensureAgentDatabaseConnection } from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiModule } from "../../sources/api/ApiModule.js";
import {
    CloudModule,
    CloudOperationError,
    type CloudUpdatedListener,
} from "../../sources/cloud/CloudModule.js";
import { createCloudDatabase } from "../../sources/cloud/CloudDatabase.js";
import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { withTeamUser } from "../../sources/team/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

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
const existingOrganization = { id: "org_existing", name: "Existing Team" };
const createdOrganization = { id: "org_created", name: "Analytical Engines" };

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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("Cloud HTTP API", () => {
    it("carries authentication and organization operations through the API and echoes mutation events", async () => {
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
        await expect(fixture.client.listCloudOrganizations()).resolves.toEqual({
            organizations: [existingOrganization],
        });
        await expect(
            fixture.client.createCloudOrganization({
                mutationId: "cloud-organization-create-1",
                name: createdOrganization.name,
            }),
        ).resolves.toEqual({ organization: createdOrganization });
        await expect(
            fixture.client.deleteCloudOrganization(createdOrganization.id, {
                mutationId: "cloud-organization-delete-1",
            }),
        ).resolves.toEqual({ deleted: true });
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
        expect(fixture.cloud.listOrganizations).toHaveBeenCalledWith(fixture.context);
        expect(fixture.cloud.createOrganization).toHaveBeenCalledWith(
            fixture.context,
            createdOrganization.name,
        );
        expect(fixture.cloud.deleteOrganization).toHaveBeenCalledWith(
            fixture.context,
            createdOrganization.id,
        );
    });

    it("returns not found for every retired Cloud and CRDT route", async () => {
        const fixture = await apiFixture(connected);
        const before = fixture.api.cursor();
        const routes = [
            ["POST", "/v0/cloud/keys/create"],
            ["POST", "/v0/cloud/keys/restore"],
            ["DELETE", "/v0/cloud/keys"],
            ["GET", "/v0/cloud/keys/backup"],
            ["GET", "/v0/cloud/devices"],
            ["DELETE", `/v0/cloud/devices/${Buffer.alloc(32, 1).toString("base64url")}`],
            ["GET", "/v0/cloud/profile"],
            ["PUT", "/v0/cloud/profile"],
            ["GET", "/v0/cloud/social"],
            ["PUT", "/v0/cloud/social/requests/ada"],
            ["DELETE", "/v0/cloud/social/requests/ada"],
            ["POST", "/v0/cloud/social/requests/ada/approve"],
            ["POST", "/v0/cloud/social/requests/ada/reject"],
            ["PUT", "/v0/cloud/social/blocked/ada"],
            ["DELETE", "/v0/cloud/social/blocked/ada"],
            ["GET", "/v0/services/crdt"],
            ["POST", "/v0/services/crdt"],
            ["GET", "/v0/services/crdt/service1"],
            ["POST", "/v0/services/crdt/service1/updates"],
            ["PUT", "/v0/services/crdt/service1/members/user1"],
            ["DELETE", "/v0/services/crdt/service1/members/user1"],
        ] as const;

        for (const [method, path] of routes) {
            const response = await apiFetch(fixture.api, fixture.context)(
                `http://happy-agent.test${path}`,
                {
                    headers: { authorization: `Bearer ${fixture.token}` },
                    method,
                },
            );
            expect(response.status, `${method} ${path}`).toBe(404);
            await expect(response.json()).resolves.toMatchObject({ code: "not_found" });
        }
        await expect(fixture.client.getCloud()).resolves.toEqual({ cloud: connected });
        await expect(fixture.client.getEvents({ after: before })).resolves.toMatchObject({
            events: [],
        });
    });

    it("rejects malformed organization input before invoking Cloud", async () => {
        const fixture = await apiFixture(connected);

        await expect(fixture.client.createCloudOrganization({ name: "   " })).rejects.toMatchObject(
            { code: "invalid_request", status: 400 },
        );
        await expect(fixture.client.deleteCloudOrganization("x".repeat(513))).rejects.toMatchObject(
            { code: "invalid_request", status: 400 },
        );
        expect(fixture.cloud.createOrganization).not.toHaveBeenCalled();
        expect(fixture.cloud.deleteOrganization).not.toHaveBeenCalled();
    });

    it("returns forbidden when Cloud refuses organization deletion", async () => {
        const fixture = await apiFixture(connected);
        fixture.cloud.deleteOrganization.mockRejectedValueOnce(
            new CloudOperationError(
                403,
                "forbidden",
                "You do not have permission to delete this Cloud organization.",
                connected,
            ),
        );

        await expect(fixture.client.deleteCloudOrganization("org_other")).rejects.toMatchObject({
            body: { cloud: connected },
            code: "forbidden",
            status: 403,
        });
    });

    it.each([disconnected, authorizing, connected])(
        "rejects account connection without side effects on a $status team node",
        async (initial) => {
            const fixture = await apiFixture(initial, { team: true });
            const before = fixture.api.cursor();
            const rejection = {
                code: "unsupported",
                status: 501,
                message: "Connecting a Cloud account is unavailable in team mode.",
            };

            await expect(
                fixture.client.startCloudAuthorization({
                    environment: "production",
                    redirectUri: "desktop-app://workos/callback",
                }),
            ).rejects.toMatchObject(rejection);
            await expect(
                fixture.client.completeCloudAuthorization({
                    callbackUrl: "desktop-app://workos/callback?code=code&state=state",
                }),
            ).rejects.toMatchObject(rejection);
            for (const path of ["/v0/cloud/auth/start", "/v0/cloud/auth/complete"]) {
                const response = await apiFetch(fixture.api, fixture.context)(
                    `http://happy-agent.test${path}`,
                    {
                        body: "not-json",
                        headers: { authorization: `Bearer ${fixture.token}` },
                        method: "POST",
                    },
                );
                expect(response.status).toBe(501);
                expect(await response.json()).toMatchObject({ code: "unsupported" });
            }
            expect(fixture.cloud.start).not.toHaveBeenCalled();
            expect(fixture.cloud.complete).not.toHaveBeenCalled();
            await expect(fixture.client.getCloud()).resolves.toEqual({ cloud: initial });
            expect((await fixture.client.getEvents({ after: before })).events).toEqual([]);
            expect(fixture.api.cursor()).toBe(before);
        },
    );

    it("rejects every organization operation before parsing bodies in team mode", async () => {
        const fixture = await apiFixture(connected, { team: true });

        await expect(fixture.client.listCloudOrganizations()).rejects.toMatchObject({
            code: "unsupported",
            status: 501,
        });
        const malformedCreate = await apiFetch(fixture.api, fixture.context)(
            "http://happy-agent.test/v0/cloud/organizations",
            {
                body: "not-json",
                headers: { authorization: `Bearer ${fixture.token}` },
                method: "POST",
            },
        );
        expect(malformedCreate.status).toBe(501);
        await expect(
            fixture.client.deleteCloudOrganization(existingOrganization.id),
        ).rejects.toMatchObject({ code: "unsupported", status: 501 });
        expect(fixture.cloud.listOrganizations).not.toHaveBeenCalled();
        expect(fixture.cloud.createOrganization).not.toHaveBeenCalled();
        expect(fixture.cloud.deleteOrganization).not.toHaveBeenCalled();
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
        expect(events.events).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    payload: { cloud: authorizing.cloud, mutationId: "cloud-real-start" },
                    type: "cloud.updated",
                }),
                expect.objectContaining({
                    payload: { cloud: completed.cloud, mutationId: "cloud-real-complete" },
                    type: "cloud.updated",
                }),
            ]),
        );
        expect(JSON.stringify(events)).not.toContain("access-a");
        expect(JSON.stringify(events)).not.toContain("access-b");
        expect(JSON.stringify(events)).not.toContain("refresh-a");
        expect(JSON.stringify(events)).not.toContain("refresh-b");
    });
});

async function apiFixture(
    initial: Cloud = disconnected,
    options: { readonly team?: boolean } = {},
) {
    const directory = await mkdtemp(join(tmpdir(), "happy-cloud-api-"));
    const root = createRootContext().named("cloud-api-test");
    const context =
        options.team === true
            ? withTeamUser(root, {
                  createdAt: 0,
                  email: user.email,
                  firstName: user.firstName,
                  id: "teamuser",
                  isOwner: false,
                  lastName: user.lastName,
                  photo: null,
                  updatedAt: 0,
                  version: VERSION_1,
                  workosUserId: user.id,
              })
            : root;
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
        createOrganization: vi.fn(async () => createdOrganization),
        deleteOrganization: vi.fn(async () => undefined),
        listOrganizations: vi.fn(async () => ({ organizations: [existingOrganization] })),
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
            ...(options.team === true ? { values: { feature: { team: { enabled: true } } } } : {}),
        },
    };
    const team =
        options.team === true
            ? {
                  authenticate: vi.fn(async (ctx: Context) => ctx),
                  authenticateIdentity: vi.fn(async (ctx: Context) => ctx),
                  enabled: true,
                  onProfileUpdated: () => () => undefined,
              }
            : undefined;
    const api = createApi(cloud, config, subscriptions, team);
    await api.beforeStart(context, {} as never);
    await api.markReady();
    const token = api.token() ?? "team-token";
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
    const durableFunctions = new DurableFunctionsModule();
    const cloud = new CloudModule(durableFunctions);
    const database = moduleDatabase(
        [...cloud.migrations, ...durableFunctions.migrations],
        "cloud-api-real",
    );
    ensureAgentDatabaseConnection(database.database);
    await database.ready;
    await resolveModuleHooks(database.context, cloud);
    const durableHooks = await resolveModuleHooks(database.context, durableFunctions);
    await durableHooks.afterStart?.(database.context, {} as never);
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
        durableFunctions.stop();
        database.close();
        await rm(directory, { force: true, recursive: true });
    });
    return { api, client, cloud, context: database.context, token };
}

function createApi(
    cloud: unknown,
    config: unknown,
    subscriptions: unknown,
    team: unknown = { enabled: false, onProfileUpdated: () => () => undefined },
): ApiModule {
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
        subscriptions as never,
        subscriptions as never,
        team as never,
        { list: () => [], onUpdated: () => () => {} } as never,
        { onUpdated: () => () => {} } as never,
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
