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
    await resolveModuleHooks(ctx, module);
    const durableHooks = await resolveModuleHooks(ctx, durableFunctions);
    await durableHooks.afterStart?.(ctx, {} as never);
    return { database, durableFunctions, module };
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
    environment = "production" as const,
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

describe("CloudModule", () => {
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
        expect(await pendingDurableCallCount(database)).toBe(0);

        const minted = await module.mint(database.context);
        expect(minted.accessToken).toBe("access-b");
        expect(minted.cloud).toEqual(connected);
        expect((await createCloudDatabase().read(database.context))?.session?.refreshToken).toBe(
            "refresh-b",
        );
        expect(workos.refresh).toHaveBeenCalledWith({ refreshToken: "refresh-a" });
        expect(events).toHaveLength(2);
        unsubscribe();
    });

    it("reads and updates the durable Cloud profile through rotated credentials", async () => {
        const { database, module } = await fixture("cloud-module-profile");
        const updates: string[] = [];
        vi.mocked(fetch).mockImplementation(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === "/v0/hello") {
                return Response.json({ message: "hello", userId: user.id });
            }
            expect(url.href).toBe("https://cloud.cluster-fluster.com/v0/profile");
            if (init?.method === "PUT") {
                return Response.json({ firstName: "Ada", username: "ada_next" });
            }
            return Response.json({ firstName: null, username: null });
        });
        await connect(module, database);
        module.onUpdated(() => updates.push("cloud"));
        module.onProfileUpdated(() => updates.push("profile"));

        await expect(module.getProfile(database.context)).resolves.toEqual({
            profile: { firstName: null, username: null },
        });
        workos.refresh.mockResolvedValueOnce({
            accessToken: "access-c",
            refreshToken: "refresh-c",
            user: { ...user, firstName: "Changed upstream" },
        });
        await expect(
            module.updateProfile(database.context, {
                firstName: "Ada",
                mutationId: "profile-update",
                username: "ada_next",
            }),
        ).resolves.toEqual({ profile: { firstName: "Ada", username: "ada_next" } });

        expect(workos.refresh).toHaveBeenNthCalledWith(1, { refreshToken: "refresh-a" });
        expect(workos.refresh).toHaveBeenNthCalledWith(2, { refreshToken: "refresh-b" });
        expect((await createCloudDatabase().read(database.context))?.session?.refreshToken).toBe(
            "refresh-c",
        );
        expect(module.status(database.context).user).toEqual({
            ...user,
            firstName: "Changed upstream",
        });
        expect(updates).toEqual(["cloud", "profile"]);
    });

    it("rejects invalid direct profile input before refreshing or contacting Cloud", async () => {
        const { database, module } = await fixture("cloud-module-profile-validation");
        await connect(module, database);
        workos.refresh.mockClear();
        vi.mocked(fetch).mockClear();

        await expect(
            module.updateProfile(database.context, {
                firstName: "Ada",
                username: "UPPERCASE",
            }),
        ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
        expect(workos.refresh).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    it("preserves rotated credentials and public state when a username is unavailable", async () => {
        const { database, module } = await fixture("cloud-module-profile-conflict");
        await connect(module, database);
        const updates: unknown[] = [];
        const profileUpdates: unknown[] = [];
        module.onUpdated((_ctx, cloud) => updates.push(cloud));
        module.onProfileUpdated((ctx) => profileUpdates.push(ctx));
        workos.refresh.mockResolvedValueOnce({
            accessToken: "access-b",
            refreshToken: "refresh-b",
            user: { ...user, firstName: "Changed upstream" },
        });
        vi.mocked(fetch).mockImplementation(async (input) => {
            const url = new URL(String(input));
            return url.pathname === "/v0/hello"
                ? Response.json({ message: "hello", userId: user.id })
                : Response.json({ error: "username_unavailable" }, { status: 409 });
        });

        await expect(
            module.updateProfile(database.context, { firstName: "Ada", username: "taken_name" }),
        ).rejects.toMatchObject({
            cloud: { status: "connected", user },
            code: "conflict",
            status: 409,
        });
        expect((await createCloudDatabase().read(database.context))?.session?.refreshToken).toBe(
            "refresh-b",
        );
        expect(module.status(database.context).user).toEqual(user);
        expect(updates).toEqual([]);
        expect(profileUpdates).toEqual([]);
    });

    it("orders disconnect after an in-flight profile update", async () => {
        const { database, module } = await fixture("cloud-module-profile-linearization");
        await connect(module, database);
        let releaseProfile!: () => void;
        let profileStarted = false;
        vi.mocked(fetch).mockImplementation(async (input) => {
            const url = new URL(String(input));
            if (url.pathname === "/v0/hello") {
                return Response.json({ message: "hello", userId: user.id });
            }
            profileStarted = true;
            await new Promise<void>((resolve) => {
                releaseProfile = resolve;
            });
            return Response.json({ firstName: "Ada", username: "ada" });
        });

        const updating = module.updateProfile(database.context, {
            firstName: "Ada",
            username: "ada",
        });
        await vi.waitFor(() => expect(profileStarted).toBe(true));
        const disconnecting = module.disconnect(database.context);
        releaseProfile();

        await expect(updating).resolves.toEqual({
            profile: { firstName: "Ada", username: "ada" },
        });
        await expect(disconnecting).resolves.toMatchObject({ status: "disconnected" });
        expect(module.status(database.context).status).toBe("disconnected");
    });

    it("treats an upstream profile validation rejection as contract drift", async () => {
        const { database, module } = await fixture("cloud-module-profile-contract-drift");
        await connect(module, database);
        const updates: unknown[] = [];
        const profileUpdates: unknown[] = [];
        module.onUpdated((_ctx, cloud) => updates.push(cloud));
        module.onProfileUpdated((ctx) => profileUpdates.push(ctx));
        workos.refresh.mockResolvedValueOnce({
            accessToken: "access-b",
            refreshToken: "refresh-b",
            user: { ...user, firstName: "Changed upstream" },
        });
        vi.mocked(fetch).mockImplementation(async (input) => {
            const url = new URL(String(input));
            return url.pathname === "/v0/hello"
                ? Response.json({ message: "hello", userId: user.id })
                : Response.json({ error: "invalid_profile" }, { status: 400 });
        });

        await expect(
            module.updateProfile(database.context, { firstName: "Ada", username: "ada" }),
        ).rejects.toMatchObject({
            cloud: { status: "connected", user },
            code: "cloud_unavailable",
            status: 503,
        });
        expect((await createCloudDatabase().read(database.context))?.session?.refreshToken).toBe(
            "refresh-b",
        );
        expect(module.status(database.context).user).toEqual(user);
        expect(updates).toEqual([]);
        expect(profileUpdates).toEqual([]);
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
            records.push({ level, message: args.map(String).join(" ") });
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
