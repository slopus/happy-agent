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
    type CloudDevice,
    type CloudDisconnected,
    type CloudSocial,
} from "@slopus/happy-agent-client";
import { ensureAgentDatabaseConnection } from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiModule } from "../../sources/api/ApiModule.js";
import {
    CloudModule,
    CloudOperationError,
    type CloudSocialUpdatedListener,
    type CloudUpdatedListener,
} from "../../sources/cloud/CloudModule.js";
import { createCloudDatabase } from "../../sources/cloud/CloudDatabase.js";
import { CloudWorkOS } from "../../sources/cloud/CloudWorkOS.js";
import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { ProfileModule } from "../../sources/profile/index.js";
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
const cloudKeyInput = {
    authHash: Buffer.alloc(32, 1).toString("base64url"),
    encryptionKey: Buffer.alloc(32, 2).toString("base64url"),
    generatedSecret: "H1-222A5-AS7TZ-QRFS4-BJ48X-Q4S7SN",
};
const cloudKeyBackup = {
    generatedSecret: cloudKeyInput.generatedSecret,
    rootSecret: Buffer.alloc(32, 3).toString("base64url"),
};
const currentDeviceId = Buffer.alloc(32, 4).toString("base64url");
const siblingDeviceId = Buffer.alloc(32, 5).toString("base64url");
const currentDevice: CloudDevice = {
    current: true,
    id: currentDeviceId,
    lastAccessedAt: 1_755_400_000_000,
    metadata: null,
};
const siblingDevice: CloudDevice = {
    current: false,
    id: siblingDeviceId,
    lastAccessedAt: 1_755_400_001_000,
    metadata: null,
};

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
const socialUnenrolled: CloudSocial = {
    blocked: [],
    connection: null,
    friends: [],
    incomingRequests: [],
    outgoingRequests: [],
    status: "unenrolled",
    updatedAt: 1,
    version: VERSION_1,
};
const socialEnrolled: CloudSocial = {
    ...socialUnenrolled,
    connection: "connecting",
    status: "enrolled",
    updatedAt: 2,
    version: VERSION_2,
};
const socialWithFriend: CloudSocial = {
    ...socialEnrolled,
    connection: "connected",
    friends: [
        {
            firstName: "Grace",
            username: "grace",
            version: VERSION_3,
        },
    ],
    updatedAt: 3,
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
    vi.spyOn(CloudWorkOS.prototype, "getVaultIdentity").mockResolvedValue(undefined);
    vi.spyOn(CloudWorkOS.prototype, "getProfileState").mockResolvedValue({
        profile: { firstName: null, username: null },
    });
});

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
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
        await expect(
            fixture.client.createCloudKeys({ ...cloudKeyInput, mutationId: "cloud-keys-create-1" }),
        ).resolves.toEqual({ cloud: connected });
        await expect(
            fixture.client.restoreCloudKeys({
                ...cloudKeyInput,
                mutationId: "cloud-keys-restore-1",
            }),
        ).resolves.toEqual({ cloud: connected });
        await expect(
            fixture.client.deleteCloudKeys({
                confirmation: "YES DELETE MY VAULT",
                mutationId: "cloud-keys-delete-1",
            }),
        ).resolves.toEqual({ cloud: connected });
        await expect(fixture.client.getCloudKeyBackup()).resolves.toEqual({
            backup: cloudKeyBackup,
        });
        await expect(fixture.client.getCloudDevices()).resolves.toEqual({
            devices: [currentDevice, siblingDevice],
        });
        await expect(fixture.client.removeCloudDevice(siblingDeviceId)).resolves.toEqual({
            devices: [currentDevice],
        });
        await expect(fixture.client.getCloudProfile()).resolves.toEqual({
            profile: { firstName: null, username: null },
        });
        await expect(fixture.client.getCloudSocial()).resolves.toEqual({
            cloudSocial: socialUnenrolled,
        });
        await expect(
            fixture.client.enrollCloudProfile({
                mutationId: "cloud-profile-1",
                username: "ada",
            }),
        ).resolves.toEqual({ profile: { firstName: "Ada", username: "ada" } });

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
            expect.objectContaining({
                payload: { mutationId: "cloud-profile-1", version: socialEnrolled.version },
                type: "cloud.social.updated",
            }),
            expect.objectContaining({
                payload: { mutationId: "cloud-profile-1" },
                type: "cloud.profile.updated",
            }),
        ]);
        expect(JSON.stringify(events)).not.toContain("access-token");
        expect(JSON.stringify(events)).not.toContain(cloudKeyBackup.rootSecret);
        expect(JSON.stringify(events)).not.toContain(cloudKeyInput.generatedSecret);

        await expect(
            fixture.client.disconnectCloud({ mutationId: "cloud-disconnect-1" }),
        ).resolves.toEqual({ cloud: disconnected });
        expect(fixture.cloud.start).toHaveBeenCalledWith(
            fixture.context,
            expect.objectContaining({ redirectUri: "desktop-app://workos/callback" }),
        );
        expect(fixture.cloud.createKeys).toHaveBeenCalledWith(
            fixture.context,
            expect.objectContaining(cloudKeyInput),
        );
        expect(fixture.cloud.restoreKeys).toHaveBeenCalledWith(
            fixture.context,
            expect.objectContaining(cloudKeyInput),
        );
        expect(fixture.cloud.deleteKeys).toHaveBeenCalledWith(
            fixture.context,
            expect.objectContaining({ confirmation: "YES DELETE MY VAULT" }),
        );
        expect(fixture.cloud.getKeyBackup).toHaveBeenCalledWith(fixture.context);
        expect(fixture.cloud.getDevices).toHaveBeenCalledWith(fixture.context);
        expect(fixture.cloud.removeDevice).toHaveBeenCalledWith(fixture.context, siblingDeviceId);
    });

    it("rejects malformed device IDs and request bodies before invoking Cloud", async () => {
        const fixture = await apiFixture(connected);

        await expect(fixture.client.removeCloudDevice("not-a-device")).rejects.toMatchObject({
            code: "invalid_request",
            status: 400,
        });
        const response = await apiFetch(fixture.api, fixture.context)(
            `http://happy-agent.test/v0/cloud/devices/${siblingDeviceId}`,
            {
                body: "{}",
                headers: {
                    authorization: `Bearer ${fixture.token}`,
                    "content-type": "application/json",
                },
                method: "DELETE",
            },
        );
        expect(response.status).toBe(400);
        expect(fixture.cloud.removeDevice).not.toHaveBeenCalled();
    });

    it("returns the authoritative roster when current-device removal conflicts", async () => {
        const fixture = await apiFixture(connected);
        fixture.cloud.removeDevice.mockRejectedValueOnce(
            new CloudOperationError(
                409,
                "conflict",
                "Disconnect Cloud to remove this device.",
                connected,
                undefined,
                [currentDevice, siblingDevice],
            ),
        );

        await expect(fixture.client.removeCloudDevice(currentDeviceId)).rejects.toMatchObject({
            body: { devices: [currentDevice, siblingDevice] },
            code: "conflict",
            status: 409,
        });
    });

    it("routes every supported Cloud friends mutation and emits compact invalidations", async () => {
        const fixture = await apiFixture(connected);
        const before = fixture.api.cursor();

        await expect(
            fixture.client.sendCloudFriendRequest("grace", { mutationId: "social-send" }),
        ).resolves.toEqual({ cloudSocial: socialWithFriend });
        await fixture.client.approveCloudFriendRequest("grace");
        await fixture.client.rejectCloudFriendRequest("grace");
        await fixture.client.revokeCloudFriendRequest("grace");
        await fixture.client.blockCloudUser("grace");
        await fixture.client.unblockCloudUser("grace");

        expect(fixture.cloud.mutateSocial.mock.calls.map((call) => call.slice(1))).toEqual([
            ["send-request", "grace"],
            ["approve-request", "grace"],
            ["reject-request", "grace"],
            ["revoke-request", "grace"],
            ["block", "grace"],
            ["unblock", "grace"],
        ]);
        const events = await fixture.client.getEvents({ after: before });
        expect(events.events[0]).toMatchObject({
            payload: { mutationId: "social-send", version: VERSION_3 },
            type: "cloud.social.updated",
        });
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

    it("does not expose an incomplete stored key backup through generic API failures", async () => {
        const fixture = await apiFixture(connected);
        fixture.cloud.getKeyBackup.mockRejectedValueOnce(
            new Error(`incomplete ${cloudKeyInput.generatedSecret} ${cloudKeyBackup.rootSecret}`),
        );

        const error = await fixture.client.getCloudKeyBackup().catch((caught: unknown) => caught);

        expect(error).toMatchObject({ code: "internal", status: 500 });
        expect(JSON.stringify(error)).not.toContain(cloudKeyInput.generatedSecret);
        expect(JSON.stringify(error)).not.toContain(cloudKeyBackup.rootSecret);
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

    it("rejects malformed profile input before invoking Cloud", async () => {
        const fixture = await apiFixture(connected);

        const error = await fixture.client
            .enrollCloudProfile({ username: "UPPERCASE" })
            .catch((caught: unknown) => caught);

        expect(error).toMatchObject({ code: "invalid_request", status: 400 });
        expect(fixture.cloud.enrollProfile).not.toHaveBeenCalled();
    });

    it("rejects an inexact vault reset confirmation before invoking Cloud", async () => {
        const fixture = await apiFixture(connected);

        const error = await fixture.client
            .deleteCloudKeys({ confirmation: "yes delete my vault" } as never)
            .catch((caught: unknown) => caught);

        expect(error).toMatchObject({ code: "invalid_request", status: 400 });
        expect(fixture.cloud.deleteKeys).not.toHaveBeenCalled();
    });

    it("returns the connected snapshot when a Cloud username is unavailable", async () => {
        const fixture = await apiFixture(connected);
        const before = fixture.api.cursor();
        fixture.cloud.enrollProfile.mockRejectedValueOnce(
            new CloudOperationError(
                409,
                "conflict",
                "The Cloud username is unavailable.",
                connected,
            ),
        );

        const error = await fixture.client
            .enrollCloudProfile({
                mutationId: "cloud-profile-conflict",
                username: "taken_name",
            })
            .catch((caught: unknown) => caught);

        expect(error).toMatchObject({
            body: { cloud: connected, code: "conflict" },
            code: "conflict",
            status: 409,
        });
        await expect(fixture.client.getEvents({ after: before })).resolves.toMatchObject({
            events: [],
        });
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

        workos.refresh.mockResolvedValueOnce({
            accessToken: "access-c",
            refreshToken: "refresh-c",
            user,
        });
        vi.mocked(fetch).mockResolvedValue(Response.json({ message: "hello", userId: user.id }));
        await expect(fixture.client.getCloudProfile()).resolves.toEqual({
            enrollment: { status: "checking" },
            profile: { firstName: null, username: null },
        });

        workos.refresh.mockResolvedValueOnce({
            accessToken: "access-d",
            refreshToken: "refresh-d",
            user,
        });
        vi.mocked(fetch).mockImplementation(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v0/hello") {
                return Response.json({ message: "hello", userId: user.id });
            }
            expect(path).toBe("/v0/profile");
            expect(init?.method).toBe("PUT");
            return Response.json({ firstName: "Ada Lovelace", username: "ada" });
        });
        await expect(
            fixture.client.enrollCloudProfile({
                mutationId: "cloud-real-profile",
                username: "ada",
            }),
        ).resolves.toEqual({
            enrollment: { status: "enrolling", username: "ada" },
            profile: { firstName: "Ada Lovelace", username: "ada" },
        });
        await vi.waitFor(async () => {
            expect((await createCloudDatabase().read(fixture.context))?.session).toMatchObject({
                enrollment: { status: "enrolled", username: "ada" },
            });
        });
        expect(
            vi
                .mocked(fetch)
                .mock.calls.some(
                    ([, init]) =>
                        init?.body ===
                        JSON.stringify({ firstName: "Ada Lovelace", username: "ada" }),
                ),
        ).toBe(true);

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
                expect.objectContaining({
                    payload: {
                        mutationId: "cloud-real-profile",
                        cloud: expect.objectContaining({
                            enrollment: { status: "enrolling", username: "ada" },
                        }),
                    },
                    type: "cloud.updated",
                }),
            ]),
        );
        expect(JSON.stringify(events)).not.toContain("access-a");
        expect(JSON.stringify(events)).not.toContain("access-b");
        expect(JSON.stringify(events)).not.toContain("access-c");
        expect(JSON.stringify(events)).not.toContain("access-d");
        expect(JSON.stringify(events)).not.toContain("refresh-a");
        expect(JSON.stringify(events)).not.toContain("refresh-b");
        expect(JSON.stringify(events)).not.toContain("refresh-c");
        expect(JSON.stringify(events)).not.toContain("refresh-d");
    });

    it("carries a confirmed vault reset through the real durable Cloud module", async () => {
        vi.mocked(CloudWorkOS.prototype.getVaultIdentity).mockResolvedValue("unknown-vault-key");
        const deleteVault = vi
            .spyOn(CloudWorkOS.prototype, "deleteVault")
            .mockResolvedValue(undefined);
        vi.mocked(fetch).mockImplementation(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v0/hello") {
                return Response.json({ message: "hello", userId: user.id });
            }
            if (path === "/v0/profile" && init?.method === "PUT") {
                return Response.json({ firstName: "Ada Lovelace", username: "ada" });
            }
            throw new Error(`Unexpected Cloud request: ${path}`);
        });
        const fixture = await actualCloudApiFixture();

        const authorizing = await fixture.client.startCloudAuthorization({
            environment: "production",
            redirectUri: "happy-auth://callback",
        });
        await fixture.client.completeCloudAuthorization({
            callbackUrl: `happy-auth://callback?code=code-a&state=${encodeURIComponent(new URL(authorizing.cloud.authorization.url).searchParams.get("state") ?? `state-${"x".repeat(16)}`)}`,
        });
        await fixture.client.enrollCloudProfile({ username: "ada" });
        await vi.waitFor(() => {
            expect(fixture.cloud.status(fixture.context)).toMatchObject({
                enrollment: { status: "enrolled" },
                keys: { status: "restore_required" },
            });
        });
        const before = fixture.api.cursor();

        await expect(
            fixture.client.deleteCloudKeys({
                confirmation: "YES DELETE MY VAULT",
                mutationId: "cloud-reset-real",
            }),
        ).resolves.toMatchObject({ cloud: { keys: { status: "create_required" } } });

        expect(deleteVault).toHaveBeenCalledWith(expect.any(String));
        const events = await fixture.client.getEvents({ after: before });
        expect(
            events.events
                .filter((event) => event.type === "cloud.updated")
                .map((event) => event.payload),
        ).toEqual([
            expect.objectContaining({
                cloud: expect.objectContaining({ keys: { status: "resetting" } }),
                mutationId: "cloud-reset-real",
            }),
            expect.objectContaining({
                cloud: expect.objectContaining({ keys: { status: "create_required" } }),
                mutationId: "cloud-reset-real",
            }),
        ]);
    });
});

async function apiFixture(initial: Cloud = disconnected) {
    const directory = await mkdtemp(join(tmpdir(), "happy-cloud-api-"));
    const context = createRootContext().named("cloud-api-test");
    let current = initial;
    let updated: CloudUpdatedListener | undefined;
    let profileUpdated: ((ctx: Context) => void) | undefined;
    let socialUpdated: CloudSocialUpdatedListener | undefined;
    let social = socialUnenrolled;
    let devices = [currentDevice, siblingDevice];
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
        createKeys: vi.fn(async () => connected),
        deleteKeys: vi.fn(async () => connected),
        getKeyBackup: vi.fn(async () => cloudKeyBackup),
        getDevices: vi.fn(async () => ({ devices })),
        mint: vi.fn(async () => ({ accessToken: "access-token", cloud: connected })),
        getProfile: vi.fn(async () => ({ profile: { firstName: null, username: null } })),
        getSocial: vi.fn(() => ({ cloudSocial: social })),
        mutateSocial: vi.fn(async (ctx: Context) => {
            social = socialWithFriend;
            socialUpdated?.(ctx, social, "mutation");
            return { cloudSocial: social };
        }),
        onUpdated: vi.fn((listener: CloudUpdatedListener) => {
            updated = listener;
            return () => {
                updated = undefined;
            };
        }),
        onProfileUpdated: vi.fn((listener: (ctx: Context) => void) => {
            profileUpdated = listener;
            return () => {
                profileUpdated = undefined;
            };
        }),
        onSocialUpdated: vi.fn((listener: CloudSocialUpdatedListener) => {
            socialUpdated = listener;
            return () => {
                socialUpdated = undefined;
            };
        }),
        restoreKeys: vi.fn(async () => connected),
        removeDevice: vi.fn(async (_ctx: Context, id: string) => {
            devices = devices.filter((device) => device.id !== id);
            return { devices };
        }),
        start: vi.fn(async (ctx: Context) => {
            current = authorizing;
            updated?.(ctx, current);
            return authorizing;
        }),
        status: vi.fn(() => current),
        socialStatus: vi.fn(() => social),
        enrollProfile: vi.fn(async (ctx: Context) => {
            social = socialEnrolled;
            socialUpdated?.(ctx, social, "mutation");
            profileUpdated?.(ctx);
            return { profile: { firstName: "Ada", username: "ada" } };
        }),
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
    const durableFunctions = new DurableFunctionsModule();
    const profile = new ProfileModule();
    profile.open("test-instance");
    const cloud = new CloudModule(durableFunctions, profile);
    const database = moduleDatabase(
        [...cloud.migrations, ...profile.migrations, ...durableFunctions.migrations],
        "cloud-api-real",
    );
    ensureAgentDatabaseConnection(database.database);
    await database.ready;
    await resolveModuleHooks(database.context, cloud);
    const durableHooks = await resolveModuleHooks(database.context, durableFunctions);
    await durableHooks.afterStart?.(database.context, {} as never);
    const local = await profile.ensure(database.context);
    await profile.update(database.context, local.id, { name: "Ada Lovelace" });
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
        subscriptions as never,
        subscriptions as never,
        { enabled: false, onProfileUpdated: () => () => undefined } as never,
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
