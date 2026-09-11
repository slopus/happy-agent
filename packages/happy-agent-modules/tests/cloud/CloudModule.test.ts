import { OauthException } from "@workos-inc/node";
import {
    agentDatabaseRows,
    agentDatabaseRun,
    ensureAgentDatabaseConnection,
} from "@slopus/happy-agent-base";
import { withLogger, type LogContext, type Logger } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    CloudModule,
    CloudOperationError,
    type CloudUpdatedListener,
} from "../../sources/cloud/CloudModule.js";
import { createCloudDatabase } from "../../sources/cloud/CloudDatabase.js";
import {
    CloudOrganizationForbiddenError,
    CloudOrganizationInvalidEndpointError,
    CloudWorkOS,
} from "../../sources/cloud/CloudWorkOS.js";
import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";
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

const user = {
    email: "person@example.com",
    firstName: "Ada",
    id: "user_01H",
    lastName: "Lovelace",
};
const databases: ModuleDatabase[] = [];
const modules: Array<{
    readonly cloud: CloudModule;
    readonly durableFunctions: DurableFunctionsModule;
}> = [];
let authorizationNumber = 0;

interface CloudLogRecord {
    readonly error?: Error;
    readonly level: keyof Logger;
    readonly message: string;
}

beforeEach(() => {
    authorizationNumber = 0;
    workos.authorization.mockReset();
    workos.exchange.mockReset();
    workos.refresh.mockReset();
    workos.create.mockReset();
    workos.authorization.mockImplementation(async () => {
        authorizationNumber += 1;
        return {
            codeVerifier: `verifier-${"x".repeat(42)}-${String(authorizationNumber)}`,
            state: `state-${"x".repeat(16)}-${String(authorizationNumber)}`,
            url: `https://api.workos.example/authorize?attempt=${String(authorizationNumber)}`,
        };
    });
    workos.exchange.mockResolvedValue({
        accessToken: "access-a",
        refreshToken: "refresh-a",
        user,
    });
    workos.refresh.mockResolvedValue({
        accessToken: "access-b",
        refreshToken: "refresh-b",
        user,
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ message: "hello", userId: user.id }, { status: 200 })),
    );
});

afterEach(async () => {
    for (const module of modules.splice(0)) {
        await module.cloud.stop();
        module.durableFunctions.stop();
    }
    for (const database of databases.splice(0)) database.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

async function fixture(name: string, logs?: CloudLogRecord[]) {
    const durableFunctions = new DurableFunctionsModule();
    const module = new CloudModule(durableFunctions);
    modules.push({ cloud: module, durableFunctions });
    const database = moduleDatabase([...module.migrations, ...durableFunctions.migrations], name);
    ensureAgentDatabaseConnection(database.database);
    databases.push(database);
    await database.ready;
    const ctx =
        logs === undefined ? database.context : withLogger(database.context, recordingLogger(logs));
    const cloudHooks = await resolveModuleHooks(ctx, module);
    const durableHooks = await resolveModuleHooks(ctx, durableFunctions);
    await durableHooks.afterStart?.(ctx, {} as never);
    return { cloudHooks, database, durableFunctions, module };
}

async function pendingDurableCallCount(database: ModuleDatabase): Promise<number> {
    const rows = await agentDatabaseRows<{ readonly count: number }>(
        database.context.db,
        sql`SELECT COUNT(*) AS count FROM durable_function_calls`,
    );
    return rows[0]?.count ?? 0;
}

async function connect(
    module: CloudModule,
    database: ModuleDatabase,
    environment: "production" | "staging" = "production",
) {
    const authorizing = await module.start(database.context, {
        environment,
        redirectUri: "happy-auth://callback",
    });
    const state = new URL(authorizing.authorization.url).searchParams.get("attempt");
    const attempt = Number(state);
    const callbackState = `state-${"x".repeat(16)}-${String(attempt)}`;
    return await module.complete(database.context, {
        callbackUrl: `happy-auth://callback?code=code-a&state=${encodeURIComponent(callbackState)}`,
    });
}

function teamToken(organizationId: string, lifetime = 300) {
    const issuedAt = Math.floor(Date.now() / 1_000);
    return `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(
        JSON.stringify({
            client_id: "client_01KZD3XE9YAFAMT0P8TD4HP73E",
            exp: issuedAt + lifetime,
            iat: issuedAt,
            iss: "https://api.workos.com/user_management/client_01KZD3XE9YAFAMT0P8TD4HP73E",
            org_id: organizationId,
            sid: "session_test",
            sub: user.id,
        }),
    ).toString("base64url")}.test-signature`;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

describe("CloudModule", () => {
    it("shares one verified organization mint across concurrent requests and reuses it", async () => {
        const { database, module } = await fixture("cloud-team-cache-concurrent");
        await connect(module, database);
        vi.mocked(fetch).mockClear();
        const accessToken = teamToken("org_target");
        workos.refresh.mockResolvedValue({ accessToken, refreshToken: "rotated", user });

        await expect(
            Promise.all(
                Array.from({ length: 10 }, () =>
                    module.mintForOrganization(database.context, "org_target"),
                ),
            ),
        ).resolves.toEqual(Array(10).fill(accessToken));
        await expect(module.mintForOrganization(database.context, "org_target")).resolves.toBe(
            accessToken,
        );
        expect(workos.refresh).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledOnce();
        expect((await createCloudDatabase().read(database.context))?.session?.refreshToken).toBe(
            "rotated",
        );
    });

    it("serves valid cached tokens during background refresh and waits only after expiry", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(1_000_000);
        const { database, module } = await fixture("cloud-team-cache-background");
        await connect(module, database);
        const accessToken = teamToken("org_target");
        workos.refresh.mockResolvedValueOnce({ accessToken, refreshToken: "rotated", user });
        await module.mintForOrganization(database.context, "org_target");

        const refresh = deferred<{
            accessToken: string;
            refreshToken: string;
            user: typeof user;
        }>();
        workos.refresh.mockImplementation(() => refresh.promise);
        vi.setSystemTime(1_270_000);
        const warm = vi.fn();
        const warming = module.mintForOrganization(database.context, "org_target").then(warm);
        try {
            await vi.waitFor(() => expect(workos.refresh).toHaveBeenCalledTimes(2));
            await vi.waitFor(() => expect(warm).toHaveBeenCalledWith(accessToken));
            await expect(module.mintForOrganization(database.context, "org_target")).resolves.toBe(
                accessToken,
            );
            vi.setSystemTime(1_300_000);
            const expired = vi.fn();
            const waiting = module
                .mintForOrganization(database.context, "org_target")
                .then(expired);
            await Promise.resolve();
            expect(expired).not.toHaveBeenCalled();
            const replacement = teamToken("org_target");
            refresh.resolve({ accessToken: replacement, refreshToken: "next", user });
            await waiting;
            expect(expired).toHaveBeenCalledWith(replacement);
            expect(workos.refresh).toHaveBeenCalledTimes(2);
        } finally {
            refresh.resolve({ accessToken: teamToken("org_target"), refreshToken: "next", user });
            await warming;
        }
    });

    it("does not put cached requests behind another organization's credential rotation", async () => {
        const { database, module } = await fixture("cloud-team-cache-lock");
        await connect(module, database);
        const accessToken = teamToken("org_cached");
        workos.refresh.mockResolvedValueOnce({ accessToken, refreshToken: "rotated", user });
        await module.mintForOrganization(database.context, "org_cached");
        const refresh = deferred<{
            accessToken: string;
            refreshToken: string;
            user: typeof user;
        }>();
        workos.refresh.mockImplementationOnce(() => refresh.promise);
        const other = module.mintForOrganization(database.context, "org_other");
        await vi.waitFor(() => expect(workos.refresh).toHaveBeenCalledTimes(2));
        const served = vi.fn();
        const cached = module.mintForOrganization(database.context, "org_cached").then(served);
        try {
            await vi.waitFor(() => expect(served).toHaveBeenCalledWith(accessToken));
        } finally {
            refresh.resolve({ accessToken: teamToken("org_other"), refreshToken: "next", user });
            await Promise.all([other, cached]);
        }
        expect(workos.refresh).toHaveBeenCalledTimes(2);
        expect(workos.refresh).toHaveBeenLastCalledWith({
            organizationId: "org_other",
            refreshToken: "rotated",
        });
    });

    it("shares failed verification without caching it and retries later with the rotated credential", async () => {
        const { database, module } = await fixture("cloud-team-cache-failure");
        await connect(module, database);
        const accessToken = teamToken("org_target");
        workos.refresh.mockResolvedValue({ accessToken, refreshToken: "rotated", user });
        vi.mocked(fetch).mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
        const results = await Promise.allSettled(
            Array.from({ length: 10 }, () =>
                module.mintForOrganization(database.context, "org_target"),
            ),
        );
        expect(results).toEqual(
            Array(10).fill(
                expect.objectContaining({
                    status: "rejected",
                    reason: expect.objectContaining({ code: "cloud_unavailable" }),
                }),
            ),
        );
        expect(workos.refresh).toHaveBeenCalledOnce();
        await expect(module.mintForOrganization(database.context, "org_target")).resolves.toBe(
            accessToken,
        );
        expect(workos.refresh).toHaveBeenLastCalledWith({
            organizationId: "org_target",
            refreshToken: "rotated",
        });
        expect(workos.refresh).toHaveBeenCalledTimes(2);
    });

    it("keeps a valid token after background failure, backs off, and never serves it after expiry", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(1_000_000);
        const { database, module } = await fixture("cloud-team-cache-background-failure");
        await connect(module, database);
        const accessToken = teamToken("org_target");
        workos.refresh.mockResolvedValueOnce({ accessToken, refreshToken: "rotated", user });
        await module.mintForOrganization(database.context, "org_target");
        workos.refresh.mockRejectedValue(new Error("offline"));
        vi.setSystemTime(1_270_000);
        await expect(module.mintForOrganization(database.context, "org_target")).resolves.toBe(
            accessToken,
        );
        // A public mint uses the same lock: its completion proves the background refresh settled.
        await expect(module.mint(database.context)).rejects.toMatchObject({
            code: "cloud_unavailable",
        });
        expect(workos.refresh).toHaveBeenCalledTimes(3);
        await expect(module.mintForOrganization(database.context, "org_target")).resolves.toBe(
            accessToken,
        );
        expect(workos.refresh).toHaveBeenCalledTimes(3);
        vi.setSystemTime(1_300_000);
        await expect(
            module.mintForOrganization(database.context, "org_target"),
        ).rejects.toMatchObject({ code: "cloud_unavailable" });
        expect(workos.refresh).toHaveBeenCalledTimes(4);
    });

    it("invalidates cached tokens only when sign-out commits and never reuses them for another account", async () => {
        const { database, module } = await fixture("cloud-team-cache-signout");
        await connect(module, database);
        const accessToken = teamToken("org_target");
        workos.refresh.mockResolvedValueOnce({ accessToken, refreshToken: "rotated", user });
        await module.mintForOrganization(database.context, "org_target");
        await expect(
            database.context.inTx(async (ctx) => {
                await module.disconnect(ctx);
                throw new Error("rollback");
            }),
        ).rejects.toThrow("rollback");
        await expect(module.mintForOrganization(database.context, "org_target")).resolves.toBe(
            accessToken,
        );
        expect(workos.refresh).toHaveBeenCalledOnce();

        await module.disconnect(database.context);
        await expect(
            module.mintForOrganization(database.context, "org_target"),
        ).rejects.toMatchObject({ code: "cloud_not_authenticated" });
        const otherUser = { ...user, id: "user_other" };
        workos.exchange.mockResolvedValueOnce({
            accessToken: "login-other",
            refreshToken: "other-refresh",
            user: otherUser,
        });
        vi.mocked(fetch).mockResolvedValueOnce(
            Response.json({ message: "hello", userId: otherUser.id }),
        );
        await connect(module, database, "staging");
        workos.refresh.mockRejectedValueOnce(new Error("offline"));
        await expect(
            module.mintForOrganization(database.context, "org_target"),
        ).rejects.toMatchObject({ code: "cloud_unavailable" });
        expect(workos.refresh).toHaveBeenLastCalledWith({
            organizationId: "org_target",
            refreshToken: "other-refresh",
        });
    });

    it("clears every organization's cached token on definitive credential rejection", async () => {
        const { database, module } = await fixture("cloud-team-cache-revoked");
        await connect(module, database);
        for (const organizationId of ["org_first", "org_second"]) {
            workos.refresh.mockResolvedValueOnce({
                accessToken: teamToken(organizationId),
                refreshToken: "rotated",
                user,
            });
            await module.mintForOrganization(database.context, organizationId);
        }
        workos.refresh.mockRejectedValueOnce(
            new OauthException(400, "request-id", "invalid_grant", "expired", {}),
        );
        await expect(module.mint(database.context)).rejects.toMatchObject({
            code: "cloud_unauthorized",
        });
        for (const organizationId of ["org_first", "org_second"]) {
            await expect(
                module.mintForOrganization(database.context, organizationId),
            ).rejects.toMatchObject({ code: "cloud_not_authenticated" });
        }
        expect(workos.refresh).toHaveBeenCalledTimes(3);
    });

    it("does not let one cancelled waiter cancel another caller's shared mint", async () => {
        const { database, module } = await fixture("cloud-team-cache-cancelled-waiter");
        await connect(module, database);
        const refresh = deferred<{
            accessToken: string;
            refreshToken: string;
            user: typeof user;
        }>();
        workos.refresh.mockImplementationOnce(() => refresh.promise);
        const controller = new AbortController();
        const cancelled = module.mintForOrganization(
            database.context,
            "org_target",
            controller.signal,
        );
        const active = module.mintForOrganization(database.context, "org_target");
        controller.abort();
        const rejected = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
        const accessToken = teamToken("org_target");
        refresh.resolve({ accessToken, refreshToken: "rotated", user });
        await rejected;
        await expect(active).resolves.toBe(accessToken);
        expect(workos.refresh).toHaveBeenCalledOnce();
    });

    it("skips queued minting when all waiters cancel before consuming a refresh token", async () => {
        const { database, module } = await fixture("cloud-team-cache-cancelled-queue");
        await connect(module, database);
        const refresh = deferred<{
            accessToken: string;
            refreshToken: string;
            user: typeof user;
        }>();
        workos.refresh.mockImplementationOnce(() => refresh.promise);
        const blocking = module.mint(database.context);
        await vi.waitFor(() => expect(workos.refresh).toHaveBeenCalledOnce());
        const controller = new AbortController();
        const cancelled = module.mintForOrganization(
            database.context,
            "org_target",
            controller.signal,
        );
        const rejected = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
        controller.abort();
        refresh.resolve({ accessToken: "public-token", refreshToken: "rotated", user });
        await blocking;
        await rejected;
        expect(workos.refresh).toHaveBeenCalledOnce();
    });

    it("fences queued organization minting behind a committed sign-out", async () => {
        const { database, module } = await fixture("cloud-team-cache-signout-queue");
        await connect(module, database);
        const refresh = deferred<{
            accessToken: string;
            refreshToken: string;
            user: typeof user;
        }>();
        workos.refresh.mockImplementationOnce(() => refresh.promise);
        const blocking = module.mint(database.context);
        await vi.waitFor(() => expect(workos.refresh).toHaveBeenCalledOnce());
        const disconnecting = module.disconnect(database.context);
        const queued = module.mintForOrganization(database.context, "org_target");
        const rejected = expect(queued).rejects.toMatchObject({ code: "cloud_not_authenticated" });
        refresh.resolve({ accessToken: "public-token", refreshToken: "rotated", user });
        await blocking;
        await disconnecting;
        await rejected;
        expect(workos.refresh).toHaveBeenCalledOnce();
        expect((await createCloudDatabase().read(database.context))?.session).toBeNull();
    });

    it("withholds and does not cache a verified token for the wrong organization", async () => {
        const { database, module } = await fixture("cloud-team-cache-wrong-organization");
        await connect(module, database);
        workos.refresh.mockResolvedValueOnce({
            accessToken: teamToken("org_other"),
            refreshToken: "rotated",
            user,
        });
        await expect(
            module.mintForOrganization(database.context, "org_target"),
        ).rejects.toMatchObject({
            code: "cloud_unavailable",
        });
        const accessToken = teamToken("org_target");
        workos.refresh.mockResolvedValueOnce({ accessToken, refreshToken: "next", user });
        await expect(module.mintForOrganization(database.context, "org_target")).resolves.toBe(
            accessToken,
        );
        expect(workos.refresh).toHaveBeenCalledTimes(2);
        expect(workos.refresh).toHaveBeenLastCalledWith({
            organizationId: "org_target",
            refreshToken: "rotated",
        });
    });

    it("rejects cached reads after stopping and leaves public minting uncached", async () => {
        const { database, module } = await fixture("cloud-team-cache-stop");
        await connect(module, database);
        const accessToken = teamToken("org_target");
        workos.refresh.mockResolvedValue({ accessToken, refreshToken: "rotated", user });
        await module.mintForOrganization(database.context, "org_target");
        await module.mint(database.context);
        await module.mint(database.context);
        expect(workos.refresh).toHaveBeenCalledTimes(3);
        await expect(module.mintForOrganization(database.context, "org_target")).resolves.toBe(
            accessToken,
        );
        expect(workos.refresh).toHaveBeenCalledTimes(3);
        await module.stop();
        await expect(module.mintForOrganization(database.context, "org_target")).rejects.toThrow(
            "stopping",
        );
    });

    it("bounds the cache and evicts the least recently used settled organization", async () => {
        const { database, module } = await fixture("cloud-team-cache-bound");
        await connect(module, database);
        workos.refresh.mockImplementation(
            async ({ organizationId }: { organizationId: string }) => ({
                accessToken: teamToken(organizationId),
                refreshToken: "rotated",
                user,
            }),
        );
        for (let index = 0; index < 100; index += 1) {
            await module.mintForOrganization(database.context, `org_${index}`);
        }
        await module.mintForOrganization(database.context, "org_0");
        await module.mintForOrganization(database.context, "org_100");
        await module.mintForOrganization(database.context, "org_0");
        expect(workos.refresh).toHaveBeenCalledTimes(101);
        await module.mintForOrganization(database.context, "org_1");
        expect(workos.refresh).toHaveBeenCalledTimes(102);
    });

    it("validates invitations before refresh and uses one rotated, verified credential without leaking links", async () => {
        const logs: CloudLogRecord[] = [];
        const { database, module } = await fixture("cloud-team-invitation", logs);
        await connect(module, database);
        const before = module.status(database.context);
        await expect(
            module.inviteTeamMember(database.context, "org_team", "invalid"),
        ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
        expect(workos.refresh).not.toHaveBeenCalled();
        const invitation = {
            acceptedAt: null,
            acceptanceLink: "https://signin.example/invite?token=recipient-secret",
            createdAt: "2026-09-10T00:00:00Z",
            email: "person@example.com",
            expiresAt: "2026-09-17T00:00:00Z",
            id: "invitation_created",
            revokedAt: null,
            status: "pending",
        };
        const request = vi.fn<typeof fetch>().mockImplementation(async (url) => {
            if (String(url).endsWith("/v0/hello")) {
                expect(
                    (await createCloudDatabase().read(database.context))?.session?.refreshToken,
                ).toBe("refresh-b");
                return Response.json({ message: "hello", userId: user.id });
            }
            return Response.json({ invitation }, { status: 201 });
        });
        vi.stubGlobal("fetch", request);
        await expect(
            module.inviteTeamMember(database.context, "org_team", " Person@Example.com "),
        ).resolves.toEqual(invitation);
        expect(workos.refresh).toHaveBeenCalledOnce();
        expect(request.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
            "/v0/hello",
            "/v0/organizations/org_team/invitations",
        ]);
        expect(module.status(database.context)).toEqual(before);
        expect(JSON.stringify(logs)).not.toMatch(/recipient-secret|access-b|refresh-b/);
    });

    it.each([
        [403, "forbidden", 403, "must administer"],
        [409, "already_member", 409, "already belongs"],
        [409, "pending_invitation", 409, "pending invitation"],
        [502, "organizations_unavailable", 503, "may already have been sent"],
    ] as const)(
        "surfaces invitation failure %s %s without replay or credential loss",
        async (status, error, expected, message) => {
            const { database, module } = await fixture(`cloud-invite-${error}`);
            await connect(module, database);
            const invite = vi.fn(async () => Response.json({ error }, { status }));
            vi.stubGlobal(
                "fetch",
                vi.fn(async (url) =>
                    String(url).endsWith("/v0/hello")
                        ? Response.json({ message: "hello", userId: user.id })
                        : invite(),
                ),
            );
            await expect(
                module.inviteTeamMember(database.context, "org_team", "person@example.com"),
            ).rejects.toMatchObject({
                status: expected,
                message: expect.stringContaining(message),
            });
            expect(invite).toHaveBeenCalledOnce();
            expect(
                (await createCloudDatabase().read(database.context))?.session?.refreshToken,
            ).toBe("refresh-b");
            expect(module.status(database.context).status).toBe("connected");
        },
    );

    it("signs out locally with the caller transaction and publishes only after commit", async () => {
        const { database, module } = await fixture("cloud-transactional-signout");
        const connected = await connect(module, database);
        const events: unknown[] = [];
        module.onUpdated((_ctx, cloud) => events.push(cloud));
        vi.mocked(fetch).mockClear();
        workos.refresh.mockClear();

        await expect(
            database.context.inTx(async (ctx) => {
                const result = await module.disconnect(ctx);
                expect(result.status).toBe("disconnected");
                expect((await createCloudDatabase().read(ctx))?.session).toBeNull();
                expect(module.status(ctx)).toEqual(connected);
                expect(events).toEqual([]);
                throw new Error("roll back sign-out");
            }),
        ).rejects.toThrow("roll back sign-out");
        expect((await createCloudDatabase().read(database.context))?.session?.refreshToken).toBe(
            "refresh-a",
        );
        expect(module.status(database.context)).toEqual(connected);
        expect(events).toEqual([]);

        const signedOut = await database.context.inTx(async (ctx) => {
            const result = await module.disconnect(ctx);
            expect(events).toEqual([]);
            return result;
        });
        expect(events).toEqual([signedOut]);
        expect(module.status(database.context)).toEqual(signedOut);
        expect((await createCloudDatabase().read(database.context))?.session).toBeNull();
        expect(await pendingDurableCallCount(database)).toBe(0);
        expect(fetch).not.toHaveBeenCalled();
        expect(workos.refresh).not.toHaveBeenCalled();
        await expect(module.disconnect(database.context)).resolves.toEqual(signedOut);
        expect(events).toHaveLength(1);
        await expect(
            module.start(database.context, {
                environment: "production",
                redirectUri: "happy-auth://callback",
            }),
        ).resolves.toMatchObject({ status: "authorizing" });
    });

    it("cancels authorization expiry locally and rejects a callback after sign-out", async () => {
        const { database, module } = await fixture("cloud-signout-pending");
        await module.start(database.context, {
            environment: "production",
            redirectUri: "happy-auth://callback",
        });
        expect(await pendingDurableCallCount(database)).toBe(1);
        const signedOut = await module.disconnect(database.context);
        expect(signedOut.status).toBe("disconnected");
        expect(await pendingDurableCallCount(database)).toBe(0);
        await expect(
            module.complete(database.context, {
                callbackUrl: `happy-auth://callback?code=late&state=${encodeURIComponent(`state-${"x".repeat(16)}-1`)}`,
            }),
        ).rejects.toMatchObject({ code: "invalid_request" });
        expect(workos.exchange).not.toHaveBeenCalled();
        expect(module.status(database.context)).toEqual(signedOut);
    });

    it("completes PKCE, verifies hello, persists refresh, and mints with rotation", async () => {
        const { database, module } = await fixture("cloud-module-complete");
        const events: unknown[] = [];
        const unsubscribe = module.onUpdated((_ctx, cloud) => events.push(cloud));

        const connected = await connect(module, database);
        expect(connected.status).toBe("connected");
        expect(connected.user).toEqual(user);
        expect(Object.isFrozen(connected.user)).toBe(true);
        expect(workos.create).toHaveBeenCalledWith({
            clientId: "client_01KZD3XE9YAFAMT0P8TD4HP73E",
            fetchFn: expect.any(Function),
            maxRetries: 0,
            timeout: 15_000,
        });
        const stored = await createCloudDatabase().read(database.context);
        expect(stored?.session?.refreshToken).toBe("refresh-a");
        expect(JSON.stringify(connected)).not.toContain("refresh-a");
        expect(JSON.stringify(connected)).not.toContain("access-a");
        expect(connected).not.toHaveProperty("enrollment");
        expect(connected).not.toHaveProperty("keys");
        expect(await pendingDurableCallCount(database)).toBe(0);

        const minted = await module.mint(database.context);
        expect(minted.accessToken).toBe("access-b");
        expect(minted.cloud).toMatchObject({
            status: "connected",
            user,
        });
        expect((await createCloudDatabase().read(database.context))?.session?.refreshToken).toBe(
            "refresh-b",
        );
        expect(workos.refresh).toHaveBeenCalledWith({ refreshToken: "refresh-a" });
        expect(events.length).toBeGreaterThanOrEqual(2);
        unsubscribe();
    });

    it("manages organizations through the serialized authenticated Cloud boundary", async () => {
        const { database, module } = await fixture("cloud-module-organizations");
        await connect(module, database);
        let refresh = 0;
        workos.refresh.mockImplementation(async () => {
            refresh += 1;
            return {
                accessToken: `organization-access-${String(refresh)}`,
                refreshToken: `organization-refresh-${String(refresh)}`,
                user,
            };
        });
        const list = vi
            .spyOn(CloudWorkOS.prototype, "listOrganizations")
            .mockResolvedValue([{ id: "org_existing", name: "Existing Team" }]);
        const create = vi
            .spyOn(CloudWorkOS.prototype, "createOrganization")
            .mockResolvedValue({ id: "org_created", name: "Analytical Engines" });
        const remove = vi
            .spyOn(CloudWorkOS.prototype, "deleteOrganization")
            .mockResolvedValue(undefined);
        const listTeams = vi.spyOn(CloudWorkOS.prototype, "listTeams").mockResolvedValue([
            {
                endpoint: "https://existing.example/agent",
                id: "org_existing",
                name: "Existing Team",
            },
        ]);
        const createTeam = vi.spyOn(CloudWorkOS.prototype, "createTeam").mockResolvedValue({
            endpoint: null,
            id: "org_created",
            name: "Analytical Engines",
        });
        const setTeamEndpoint = vi
            .spyOn(CloudWorkOS.prototype, "setTeamEndpoint")
            .mockResolvedValueOnce("tailcat://tcAnalytical:32123")
            .mockResolvedValueOnce("https://created.example/agent");

        await expect(module.listOrganizations(database.context)).resolves.toEqual({
            organizations: [{ id: "org_existing", name: "Existing Team" }],
        });
        await expect(
            module.createOrganization(database.context, "Analytical Engines"),
        ).resolves.toEqual({ id: "org_created", name: "Analytical Engines" });
        await expect(
            module.deleteOrganization(database.context, "org_created"),
        ).resolves.toBeUndefined();
        await expect(module.listTeams(database.context)).resolves.toEqual([
            {
                endpoint: "https://existing.example/agent",
                id: "org_existing",
                name: "Existing Team",
            },
        ]);
        await expect(
            module.createTeam(
                database.context,
                "Analytical Engines",
                "tailcat://tcAnalytical:32123",
            ),
        ).resolves.toEqual({
            endpoint: "tailcat://tcAnalytical:32123",
            id: "org_created",
            name: "Analytical Engines",
        });
        await expect(
            module.setTeamEndpoint(
                database.context,
                "org_created",
                "https://created.example/agent",
            ),
        ).resolves.toBe("https://created.example/agent");

        expect(list).toHaveBeenCalledWith("organization-access-1");
        expect(create).toHaveBeenCalledWith("organization-access-2", "Analytical Engines");
        expect(remove).toHaveBeenCalledWith("organization-access-3", "org_created");
        expect(listTeams).toHaveBeenCalledWith("organization-access-4");
        expect(createTeam).toHaveBeenCalledWith("organization-access-5", "Analytical Engines");
        expect(setTeamEndpoint).toHaveBeenNthCalledWith(
            1,
            "organization-access-5",
            "org_created",
            "tailcat://tcAnalytical:32123",
        );
        expect(setTeamEndpoint).toHaveBeenCalledWith(
            "organization-access-6",
            "org_created",
            "https://created.example/agent",
        );
        expect((await createCloudDatabase().read(database.context))?.session?.refreshToken).toBe(
            "organization-refresh-6",
        );
    });

    it("withholds long-lived tokens after persisting rotation, then releases a five-minute team token", async () => {
        const { database, module } = await fixture("cloud-module-short-lived-team-mint");
        await connect(module, database);
        const issuedAt = Math.floor(Date.now() / 1_000);
        const makeToken = (lifetime: number) =>
            `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(
                JSON.stringify({
                    client_id: "client_01KZD3XE9YAFAMT0P8TD4HP73E",
                    exp: issuedAt + lifetime,
                    iat: issuedAt,
                    iss: "https://api.workos.com/user_management/client_01KZD3XE9YAFAMT0P8TD4HP73E",
                    org_id: "org_target",
                    sid: "session_test",
                    sub: user.id,
                }),
            ).toString("base64url")}.test-signature`;
        workos.refresh.mockResolvedValueOnce({
            accessToken: makeToken(3600),
            refreshToken: "rotated-after-withheld",
            user,
        });
        await expect(
            module.mintShortLivedForOrganization(database.context, "org_target"),
        ).rejects.toThrow("longer than five minutes");
        expect((await createCloudDatabase().read(database.context))?.session?.refreshToken).toBe(
            "rotated-after-withheld",
        );
        const accessToken = makeToken(300);
        workos.refresh.mockResolvedValueOnce({ accessToken, refreshToken: "next-refresh", user });
        await expect(
            module.mintShortLivedForOrganization(database.context, "org_target"),
        ).resolves.toEqual({ accessToken, expiresAt: (issuedAt + 300) * 1_000 });
        expect(workos.refresh).toHaveBeenLastCalledWith({
            refreshToken: "rotated-after-withheld",
            organizationId: "org_target",
        });
        expect(JSON.stringify(module.status(database.context))).not.toContain(accessToken);
        workos.refresh.mockClear();
        await expect(module.mintShortLivedForOrganization(database.context, "")).rejects.toThrow(
            "organization ID is invalid",
        );
        expect(workos.refresh).not.toHaveBeenCalled();
    });

    it("mints a team token with organization scope and durably rotates the shared credential", async () => {
        const { database, module } = await fixture("cloud-module-team-mint");
        await connect(module, database);
        workos.refresh.mockClear();
        const previousToken = (await createCloudDatabase().read(database.context))?.session
            ?.refreshToken;
        const accessToken = teamToken("org_target");
        workos.refresh.mockResolvedValueOnce({
            accessToken,
            refreshToken: "team-refresh",
            user,
        });
        await expect(module.mintForOrganization(database.context, "org_target")).resolves.toBe(
            accessToken,
        );
        expect(workos.refresh).toHaveBeenCalledWith({
            refreshToken: previousToken,
            organizationId: "org_target",
        });
        expect((await createCloudDatabase().read(database.context))?.session?.refreshToken).toBe(
            "team-refresh",
        );
        workos.refresh.mockClear();
        const cancelled = AbortSignal.abort();
        await expect(
            module.mintForOrganization(database.context, "org_target", cancelled),
        ).rejects.toThrow();
        expect(workos.refresh).not.toHaveBeenCalled();
    });

    it.each([
        ["production", "client_01KZD3XE9YAFAMT0P8TD4HP73E"],
        ["staging", "client_01KZD3XE4EW1AF1P6WTFHBPR4J"],
    ] as const)(
        "returns the reverified WorkOS state for the connected %s Cloud account",
        async (environment, workosClientId) => {
            const { database, module } = await fixture(`cloud-module-workos-state-${environment}`);
            await connect(module, database, environment);

            await expect(module.getWorkOSState(database.context)).resolves.toEqual({
                workosClientId,
                workosUserId: user.id,
            });
            expect(workos.refresh).toHaveBeenCalledWith({ refreshToken: "refresh-a" });
            expect(
                (await createCloudDatabase().read(database.context))?.session?.refreshToken,
            ).toBe("refresh-b");
        },
    );

    it("rejects invalid and unauthorized organization mutations with display-safe errors", async () => {
        const { database, module } = await fixture("cloud-module-organization-errors");
        await connect(module, database);
        const create = vi.spyOn(CloudWorkOS.prototype, "createOrganization");
        const remove = vi
            .spyOn(CloudWorkOS.prototype, "deleteOrganization")
            .mockRejectedValue(new CloudOrganizationForbiddenError());
        const setTeamEndpoint = vi
            .spyOn(CloudWorkOS.prototype, "setTeamEndpoint")
            .mockRejectedValueOnce(new CloudOrganizationInvalidEndpointError())
            .mockRejectedValueOnce(new CloudOrganizationForbiddenError());

        await expect(module.createOrganization(database.context, "   ")).rejects.toMatchObject({
            code: "invalid_request",
            status: 400,
        } satisfies Partial<CloudOperationError>);
        expect(create).not.toHaveBeenCalled();
        await expect(
            module.deleteOrganization(database.context, "org_other"),
        ).rejects.toMatchObject({
            code: "forbidden",
            status: 403,
        } satisfies Partial<CloudOperationError>);
        expect(remove).toHaveBeenCalledTimes(1);
        await expect(
            module.setTeamEndpoint(database.context, "org_other", "https://invalid.example"),
        ).rejects.toMatchObject({
            code: "invalid_request",
            status: 400,
        } satisfies Partial<CloudOperationError>);
        await expect(
            module.setTeamEndpoint(database.context, "org_other", "https://forbidden.example"),
        ).rejects.toMatchObject({
            code: "forbidden",
            status: 403,
        } satisfies Partial<CloudOperationError>);
        expect(setTeamEndpoint).toHaveBeenCalledTimes(2);
    });

    it("validates a creation endpoint before writing and reports a partially created team", async () => {
        const { database, module } = await fixture("cloud-module-team-creation-errors");
        await connect(module, database);
        const createTeam = vi.spyOn(CloudWorkOS.prototype, "createTeam").mockResolvedValue({
            endpoint: null,
            id: "org_partial",
            name: "Partial Team",
        });
        const setTeamEndpoint = vi
            .spyOn(CloudWorkOS.prototype, "setTeamEndpoint")
            .mockRejectedValue(new Error("upstream write failed"));

        await expect(
            module.createTeam(database.context, "Invalid Team", "file:///tmp/agent.sock"),
        ).rejects.toMatchObject({
            code: "invalid_request",
            status: 400,
        } satisfies Partial<CloudOperationError>);
        expect(createTeam).not.toHaveBeenCalled();

        await expect(
            module.createTeam(database.context, "Partial Team", "tailcat://tcPartial:32123"),
        ).rejects.toMatchObject({
            code: "cloud_unavailable",
            message: expect.stringContaining(
                "Happy team org_partial was created, but its endpoint could not be configured. Use update_happy_team",
            ),
            status: 503,
        } satisfies Partial<CloudOperationError>);
        expect(createTeam).toHaveBeenCalledTimes(1);
        expect(setTeamEndpoint).toHaveBeenCalledWith(
            expect.any(String),
            "org_partial",
            "tailcat://tcPartial:32123",
        );
    });

    it("returns one immutable snapshot when the same application joins authorization", async () => {
        const { database, module } = await fixture("cloud-module-join");
        const events: unknown[] = [];
        module.onUpdated((_ctx, cloud) => events.push(cloud));
        const request = {
            environment: "production" as const,
            redirectUri: "happy-auth://callback",
        };

        const first = await module.start(database.context, request);
        const second = await module.start(database.context, request);

        expect(second).toBe(first);
        expect(workos.authorization).toHaveBeenCalledTimes(1);
        expect(events).toHaveLength(1);
        expect(Object.isFrozen(first)).toBe(true);
        expect(Object.isFrozen(first.authorization)).toBe(true);
    });

    it("rejects an ambient caller transaction before consuming WorkOS credentials", async () => {
        const { database, module } = await fixture("cloud-module-owned-transaction");

        await database.context.inTx(async (transactionCtx) => {
            await expect(
                module.start(transactionCtx, {
                    environment: "production",
                    redirectUri: "happy-auth://callback",
                }),
            ).rejects.toThrow("transaction");
        });
        expect(workos.authorization).not.toHaveBeenCalled();
        expect(module.status(database.context).status).toBe("disconnected");

        await connect(module, database);
        await database.context.inTx(async (transactionCtx) => {
            await expect(module.mint(transactionCtx)).rejects.toThrow("transaction");
        });
        expect(workos.refresh).not.toHaveBeenCalled();
        expect((await createCloudDatabase().read(database.context))?.session?.refreshToken).toBe(
            "refresh-a",
        );
    });

    it("keeps the legitimate attempt active after a wrong-state callback", async () => {
        const { database, module } = await fixture("cloud-module-state");
        const authorizing = await module.start(database.context, {
            environment: "production",
            redirectUri: "happy-auth://callback",
        });

        await expect(
            module.complete(database.context, {
                callbackUrl: "happy-auth://callback?code=stolen&state=wrong-state",
            }),
        ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
        expect(module.status(database.context)).toEqual(authorizing);

        const callbackState = `state-${"x".repeat(16)}-1`;
        await expect(
            module.complete(database.context, {
                callbackUrl: `happy-auth://callback?code=code-a&state=${encodeURIComponent(callbackState)}`,
            }),
        ).resolves.toMatchObject({ status: "connected" });
    });

    it("settles expiration before inspecting a stale callback", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(1_000);
        const { database, module } = await fixture("cloud-module-expired-callback");
        await module.start(database.context, {
            environment: "production",
            redirectUri: "happy-auth://callback",
        });
        vi.setSystemTime(10 * 60 * 1_000 + 1_000);

        await expect(
            module.complete(database.context, {
                callbackUrl: "happy-auth://callback?code=stolen&state=wrong-state",
            }),
        ).rejects.toMatchObject({
            cloud: { error: { code: "authorization_expired" }, status: "disconnected" },
            code: "invalid_request",
            status: 400,
        });
        expect(module.status(database.context)).toMatchObject({
            error: { code: "authorization_expired" },
            status: "disconnected",
        });
    });

    it("rearms an authorization timer that fires early after clock rollback", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const { database, module } = await fixture("cloud-module-expiry-clock-rollback");
        await module.start(database.context, {
            environment: "production",
            redirectUri: "happy-auth://callback",
        });
        vi.setSystemTime(0);

        await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
        expect(module.status(database.context).status).toBe("authorizing");
        await vi.advanceTimersByTimeAsync(10_000);
        expect(module.status(database.context)).toMatchObject({
            error: { code: "authorization_expired" },
            status: "disconnected",
        });
    });

    it("retries authorization expiry after a transient storage failure", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const { database, module } = await fixture("cloud-module-expiry-storage-retry");
        await module.start(database.context, {
            environment: "production",
            redirectUri: "happy-auth://callback",
        });
        await agentDatabaseRun(
            database.context.db,
            sql.raw(`CREATE TRIGGER fail_cloud_expiry
                BEFORE INSERT ON happy_agent_cloud_state
                BEGIN SELECT RAISE(FAIL, 'temporary'); END`),
        );

        await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
        expect(module.status(database.context).status).toBe("authorizing");
        await agentDatabaseRun(database.context.db, sql.raw("DROP TRIGGER fail_cloud_expiry"));
        await vi.advanceTimersByTimeAsync(5_000);
        expect(module.status(database.context)).toMatchObject({
            error: { code: "authorization_expired" },
            status: "disconnected",
        });
    });

    it("distinguishes user denial from a temporary OAuth callback failure", async () => {
        const denied = await fixture("cloud-module-oauth-denied");
        await denied.module.start(denied.database.context, {
            environment: "production",
            redirectUri: "happy-auth://callback",
        });
        const firstState = encodeURIComponent(`state-${"x".repeat(16)}-1`);
        await expect(
            denied.module.complete(denied.database.context, {
                callbackUrl: `happy-auth://callback?error=access_denied&state=${firstState}`,
            }),
        ).rejects.toMatchObject({
            cloud: { error: { code: "authorization_rejected" } },
            code: "cloud_unauthorized",
            status: 409,
        });

        const unavailable = await fixture("cloud-module-oauth-unavailable");
        await unavailable.module.start(unavailable.database.context, {
            environment: "production",
            redirectUri: "happy-auth://callback",
        });
        const secondState = encodeURIComponent(`state-${"x".repeat(16)}-2`);
        await expect(
            unavailable.module.complete(unavailable.database.context, {
                callbackUrl: `happy-auth://callback?error=server_error&state=${secondState}`,
            }),
        ).rejects.toMatchObject({
            cloud: { error: null, status: "disconnected" },
            code: "cloud_unavailable",
            status: 503,
        });
    });

    it("logs the safe failure phase and status when Happy Cloud rejects a callback token", async () => {
        const logs: CloudLogRecord[] = [];
        const { database, module } = await fixture("cloud-module-hello-log", logs);
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            cancel: () => {
                cancelled = true;
            },
            start: (controller) => {
                controller.enqueue(new TextEncoder().encode("access-a refresh-a code-a"));
            },
        });
        vi.mocked(fetch).mockResolvedValueOnce(new Response(body, { status: 401 }));

        await expect(connect(module, database)).rejects.toMatchObject({
            code: "cloud_unavailable",
            status: 503,
        });
        expect(logs).toEqual([
            {
                level: "warn",
                message:
                    "cloud:authorization:error environment=production phase=cloud-hello reason=response-rejected status=401",
            },
        ]);
        expect(cancelled).toBe(true);
        expect(JSON.stringify(logs)).not.toMatch(/access-a|refresh-a|code-a/);
    });

    it("does not replay a callback or activate memory when credential storage fails", async () => {
        const { database, module } = await fixture("cloud-module-storage-failure");
        await module.start(database.context, {
            environment: "production",
            redirectUri: "happy-auth://callback",
        });
        await agentDatabaseRun(
            database.context.db,
            sql.raw(`CREATE TRIGGER fail_cloud_write
                BEFORE INSERT ON happy_agent_cloud_state
                BEGIN SELECT RAISE(FAIL, 'sensitive database detail'); END`),
        );
        const state = encodeURIComponent(`state-${"x".repeat(16)}-1`);
        const callbackUrl = `happy-auth://callback?code=code-a&state=${state}`;

        const failure = await module
            .complete(database.context, { callbackUrl })
            .catch((error: unknown) => error);
        expect(failure).toMatchObject({
            message: "The Cloud authentication state could not be stored.",
        });
        expect(JSON.stringify(failure)).not.toContain("sensitive database detail");
        expect(module.status(database.context).status).toBe("authorizing");
        expect(workos.exchange).toHaveBeenCalledTimes(1);

        await expect(module.complete(database.context, { callbackUrl })).rejects.toMatchObject({
            code: "invalid_request",
            status: 400,
        });
        expect(workos.exchange).toHaveBeenCalledTimes(1);

        await agentDatabaseRun(database.context.db, sql.raw("DROP TRIGGER fail_cloud_write"));
        const replacement = await module.start(database.context, {
            environment: "production",
            redirectUri: "happy-auth://callback",
        });
        expect(replacement.authorization.url).toContain("attempt=2");
        expect(module.status(database.context)).toBe(replacement);
    });

    it("accepts application redirects while rejecting unsafe transports", async () => {
        const { database, module } = await fixture("cloud-module-redirects");

        await expect(
            module.start(database.context, {
                environment: "production",
                redirectUri: "http://127.0.0.1:43121/callback",
            }),
        ).resolves.toMatchObject({ status: "authorizing" });
        await module.disconnect(database.context);
        await expect(
            module.start(database.context, {
                environment: "production",
                redirectUri: "desktop-app://workos/callback",
            }),
        ).resolves.toMatchObject({ status: "authorizing" });
        await module.disconnect(database.context);

        for (const redirectUri of [
            "http://example.com/callback",
            "javascript:alert(1)",
            "file:///tmp/callback",
        ]) {
            await expect(
                module.start(database.context, { environment: "production", redirectUri }),
            ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
        }
    });

    it("preserves the replacement refresh token when hello is unavailable", async () => {
        const { database, module } = await fixture("cloud-module-hello-failure");
        await connect(module, database);
        vi.mocked(fetch).mockResolvedValueOnce(new Response("unavailable", { status: 401 }));

        await expect(module.mint(database.context)).rejects.toMatchObject({
            cloud: { status: "connected" },
            code: "cloud_unavailable",
            status: 503,
        });
        expect((await createCloudDatabase().read(database.context))?.session?.refreshToken).toBe(
            "refresh-b",
        );

        workos.refresh.mockResolvedValueOnce({
            accessToken: "access-c",
            refreshToken: "refresh-c",
            user,
        });
        await expect(module.mint(database.context)).resolves.toMatchObject({
            accessToken: "access-c",
        });
        expect(workos.refresh).toHaveBeenLastCalledWith({ refreshToken: "refresh-b" });
    });

    it("rejects an initial user mismatch but preserves a rotated session mismatch", async () => {
        const first = await fixture("cloud-module-initial-mismatch");
        vi.mocked(fetch).mockResolvedValueOnce(
            Response.json({ message: "hello", userId: "another-user" }),
        );

        await expect(connect(first.module, first.database)).rejects.toMatchObject({
            cloud: { status: "disconnected" },
            code: "cloud_unauthorized",
            status: 409,
        });
        expect((await createCloudDatabase().read(first.database.context))?.session).toBeNull();

        const second = await fixture("cloud-module-refresh-mismatch");
        await connect(second.module, second.database);
        vi.mocked(fetch).mockResolvedValueOnce(
            Response.json({ message: "hello", userId: "another-user" }),
        );

        await expect(second.module.mint(second.database.context)).rejects.toMatchObject({
            cloud: { status: "connected" },
            code: "cloud_unavailable",
            status: 503,
        });
        expect(
            (await createCloudDatabase().read(second.database.context))?.session?.refreshToken,
        ).toBe("refresh-b");
    });

    it("cancels an oversized hello response without storing the attempted login", async () => {
        const { database, module } = await fixture("cloud-module-oversized-hello");
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            cancel: () => {
                cancelled = true;
            },
            start: (controller) => {
                controller.enqueue(new Uint8Array(8 * 1_024 + 1));
            },
        });
        vi.mocked(fetch).mockResolvedValueOnce(new Response(body));

        await expect(connect(module, database)).rejects.toMatchObject({
            cloud: { status: "disconnected" },
            code: "cloud_unavailable",
            status: 503,
        });
        expect(cancelled).toBe(true);
        expect((await createCloudDatabase().read(database.context))?.session).toBeNull();
    });

    it("clears authentication and emits an update on definitive WorkOS revocation", async () => {
        const { database, module } = await fixture("cloud-module-revoked");
        await connect(module, database);
        const events: Parameters<CloudUpdatedListener>[1][] = [];
        module.onUpdated((_ctx, cloud) => events.push(cloud));
        workos.refresh.mockRejectedValueOnce(
            new OauthException(400, "request-id", "invalid_grant", "expired", {}),
        );

        const error = await module.mint(database.context).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(CloudOperationError);
        expect(error).toMatchObject({
            cloud: {
                error: { code: "credentials_rejected" },
                status: "disconnected",
            },
            code: "cloud_unauthorized",
            status: 409,
        });
        expect((await createCloudDatabase().read(database.context))?.session).toBeNull();
        expect(events).toHaveLength(1);
    });

    it("settles a process-local pending attempt as expired after restart", async () => {
        const { database, durableFunctions, module } = await fixture("cloud-module-restart");
        const authorizing = await module.start(database.context, {
            environment: "staging",
            redirectUri: "another-app://oauth/callback",
        });
        expect(await pendingDurableCallCount(database)).toBe(1);
        await module.stop();
        durableFunctions.stop();

        const restartedDurableFunctions = new DurableFunctionsModule();
        const restarted = new CloudModule(restartedDurableFunctions);
        modules.push({ cloud: restarted, durableFunctions: restartedDurableFunctions });
        await resolveModuleHooks(database.context, restarted);
        const durableHooks = await resolveModuleHooks(database.context, restartedDurableFunctions);
        await durableHooks.afterStart?.(database.context, {} as never);

        expect(restarted.status(database.context)).toMatchObject({
            error: { code: "authorization_expired" },
            status: "disconnected",
        });
        await vi.waitFor(() => {
            expect(restarted.status(database.context).version > authorizing.version).toBe(true);
        });
        expect(await pendingDurableCallCount(database)).toBe(0);
    });

    it("orders a concurrent disconnect after in-flight minting without restoring credentials", async () => {
        const { database, module } = await fixture("cloud-module-linearization");
        await connect(module, database);
        let releaseRefresh!: (value: unknown) => void;
        workos.refresh.mockImplementationOnce(
            async () =>
                await new Promise((resolve) => {
                    releaseRefresh = resolve;
                }),
        );

        const minting = module.mint(database.context);
        await vi.waitFor(() => expect(workos.refresh).toHaveBeenCalledTimes(1));
        const disconnecting = module.disconnect(database.context);
        releaseRefresh({ accessToken: "access-c", refreshToken: "refresh-c", user });

        await expect(minting).resolves.toMatchObject({ accessToken: "access-c" });
        await expect(disconnecting).resolves.toMatchObject({ status: "disconnected" });
        expect(module.status(database.context).status).toBe("disconnected");
        expect((await createCloudDatabase().read(database.context))?.session).toBeNull();
    });
});

function recordingLogger(records: CloudLogRecord[]): Logger {
    const write =
        (level: keyof Logger) =>
        (_context: LogContext, ...args: readonly unknown[]) => {
            const error = args.find((argument): argument is Error => argument instanceof Error);
            records.push({
                ...(error === undefined ? {} : { error }),
                level,
                message: args.map(String).join(" "),
            });
        };
    return {
        debug: write("debug"),
        error: write("error"),
        fatal: write("fatal"),
        info: write("info"),
        trace: write("trace"),
        warn: write("warn"),
    };
}
