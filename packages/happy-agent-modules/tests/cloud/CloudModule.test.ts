import { OauthException } from "@workos-inc/node";
import {
    destroyIdentity,
    HttpRelaySessionProvider,
    importIdentityKeyPair,
    MurmurClient,
    type MurmurClientOptions,
    type MurmurDeviceRosterEntry,
} from "@slopus/murmur";
import {
    agentDatabaseRows,
    agentDatabaseRun,
    ensureAgentDatabaseConnection,
} from "@slopus/happy-agent-base";
import { withLogger, type Context, type LogContext, type Logger } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    CloudModule,
    CloudOperationError,
    CloudStorageConflictError,
    type CloudUpdatedListener,
} from "../../sources/cloud/CloudModule.js";
import { createCloudDatabase } from "../../sources/cloud/CloudDatabase.js";
import { createCloudKeyBundle } from "../../sources/cloud/CloudKeys.js";
import { createCloudKeysDatabase } from "../../sources/cloud/CloudKeysDatabase.js";
import { CloudMurmurStore } from "../../sources/cloud/CloudMurmurStore.js";
import {
    CloudOrganizationForbiddenError,
    CloudUsernameUnavailableError,
    CloudVaultDeleteRejectedError,
    CloudWorkOS,
} from "../../sources/cloud/CloudWorkOS.js";
import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { ProfileModule } from "../../sources/profile/index.js";
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
const cloudKeyInput = {
    authHash: Buffer.alloc(32, 1).toString("base64url"),
    encryptionKey: Buffer.alloc(32, 2).toString("base64url"),
    generatedSecret: "H1-222A5-AS7TZ-QRFS4-BJ48X-Q4S7SN",
};
const deleteCloudKeysInput = { confirmation: "YES DELETE MY VAULT" as const };

const databases: ModuleDatabase[] = [];
const modules: Array<{
    readonly cloud: CloudModule;
    readonly durableFunctions: DurableFunctionsModule;
    readonly profile: ProfileModule;
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
    vi.spyOn(CloudWorkOS.prototype, "getVaultIdentity").mockResolvedValue(undefined);
    vi.spyOn(CloudWorkOS.prototype, "getProfileState").mockResolvedValue({
        profile: { firstName: null, username: null },
    });
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
    const profile = new ProfileModule();
    profile.open("test-instance");
    const module = new CloudModule(durableFunctions, profile);
    modules.push({ cloud: module, durableFunctions, profile });
    const database = moduleDatabase(
        [...module.migrations, ...profile.migrations, ...durableFunctions.migrations],
        name,
    );
    ensureAgentDatabaseConnection(database.database);
    databases.push(database);
    await database.ready;
    const ctx =
        logs === undefined ? database.context : withLogger(database.context, recordingLogger(logs));
    const cloudHooks = await resolveModuleHooks(ctx, module);
    const durableHooks = await resolveModuleHooks(ctx, durableFunctions);
    await durableHooks.afterStart?.(ctx, {} as never);
    const local = await profile.ensure(ctx);
    await profile.update(ctx, local.id, { name: "Ada" });
    return { cloudHooks, database, durableFunctions, module, profile };
}

async function pendingDurableCallCount(database: ModuleDatabase): Promise<number> {
    const rows = await agentDatabaseRows<{ readonly count: number }>(
        database.context.db,
        sql`SELECT COUNT(*) AS count FROM durable_function_calls`,
    );
    return rows[0]?.count ?? 0;
}

interface PendingDurableCallRow {
    readonly arguments_json: string;
    readonly id: string;
    readonly lock_keys_json: string;
    readonly operation_id: string | null;
}

async function pendingDurableCalls(
    database: ModuleDatabase,
    functionName: string,
): Promise<readonly PendingDurableCallRow[]> {
    return await agentDatabaseRows<PendingDurableCallRow>(
        database.context.db,
        sql`SELECT id, operation_id, arguments_json, lock_keys_json
            FROM durable_function_calls
            WHERE "function" = ${functionName}
            ORDER BY created_at, id`,
    );
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

function existingCloudProfile(): void {
    vi.mocked(CloudWorkOS.prototype.getProfileState).mockResolvedValue({
        profile: { firstName: "Ada", username: "ada" },
    });
}

async function waitForCloud(
    module: CloudModule,
    database: ModuleDatabase,
    expected: Record<string, unknown>,
): Promise<void> {
    await vi.waitFor(() => {
        expect(module.status(database.context)).toMatchObject(expected);
    });
}

describe("CloudModule", () => {
    it("keeps authentication connected while durable key discovery retries", async () => {
        existingCloudProfile();
        vi.mocked(CloudWorkOS.prototype.getVaultIdentity).mockRejectedValue(
            new Error("vault unavailable"),
        );
        const { database, module } = await fixture("cloud-module-vault-status-unavailable");

        await expect(connect(module, database)).resolves.toMatchObject({
            enrollment: { status: "checking" },
            status: "connected",
            user,
        });
        await waitForCloud(module, database, { enrollment: { status: "enrolled" } });
        expect(module.status(database.context).keys).toBeUndefined();
        expect(await pendingDurableCallCount(database)).toBe(1);
    });

    it("recovers the transactionally owned key discovery after restart", async () => {
        existingCloudProfile();
        vi.mocked(CloudWorkOS.prototype.getVaultIdentity).mockRejectedValue(
            new Error("vault unavailable"),
        );
        const { database, durableFunctions, module, profile } = await fixture(
            "cloud-module-vault-status-recovery",
        );

        await connect(module, database);
        await waitForCloud(module, database, { enrollment: { status: "enrolled" } });
        await vi.waitFor(async () => expect(await pendingDurableCallCount(database)).toBe(1));
        await expect(createCloudDatabase().read(database.context)).resolves.toMatchObject({
            session: { keysReconciliationCallId: expect.any(String) },
        });

        await module.stop();
        durableFunctions.stop();
        vi.mocked(CloudWorkOS.prototype.getVaultIdentity).mockResolvedValue(undefined);

        const restartedDurableFunctions = new DurableFunctionsModule();
        const restarted = new CloudModule(restartedDurableFunctions, profile);
        modules.push({
            cloud: restarted,
            durableFunctions: restartedDurableFunctions,
            profile,
        });
        await resolveModuleHooks(database.context, restarted);
        const durableHooks = await resolveModuleHooks(database.context, restartedDurableFunctions);
        await durableHooks.afterStart?.(database.context, {} as never);

        await waitForCloud(restarted, database, { keys: { status: "create_required" } });
        await vi.waitFor(async () => expect(await pendingDurableCallCount(database)).toBe(0));
    });

    it("requires restoration when Cloud already has an unknown vault identity", async () => {
        existingCloudProfile();
        vi.mocked(CloudWorkOS.prototype.getVaultIdentity).mockResolvedValue(
            "an-existing-opaque-public-identity",
        );
        const { database, module } = await fixture("cloud-module-unknown-vault-key");

        await connect(module, database);
        await waitForCloud(module, database, {
            keys: { status: "restore_required" },
            status: "connected",
        });
    });

    it("requires creation when no remote bundle exists and commits the account root", async () => {
        existingCloudProfile();
        const { database, module } = await fixture("cloud-module-create-keys");
        const saveVault = vi.spyOn(CloudWorkOS.prototype, "saveVault").mockResolvedValue(undefined);

        await connect(module, database);
        await waitForCloud(module, database, { keys: { status: "create_required" } });
        const ready = await module.createKeys(database.context, cloudKeyInput);

        expect(ready.keys).toEqual({
            identityKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
            status: "ready",
        });
        expect(saveVault).toHaveBeenCalledWith(
            "access-b",
            cloudKeyInput.authHash,
            expect.any(String),
            expect.any(String),
        );
        const local = await createCloudKeysDatabase().read(database.context, {
            environment: "production",
            userId: user.id,
        });
        expect(local).toMatchObject({
            generatedSecret: cloudKeyInput.generatedSecret,
            identityKey: ready.keys?.status === "ready" ? ready.keys.identityKey : undefined,
            status: "ready",
        });
        await expect(module.getKeyBackup(database.context)).resolves.toEqual({
            generatedSecret: cloudKeyInput.generatedSecret,
            rootSecret: local?.rootSecret,
        });
        expect(JSON.stringify(ready)).not.toContain(cloudKeyInput.authHash);
        expect(JSON.stringify(ready)).not.toContain(cloudKeyInput.encryptionKey);
        expect(JSON.stringify(ready)).not.toContain(cloudKeyInput.generatedSecret);
        expect(JSON.stringify(ready)).not.toContain(local?.rootSecret);
    });

    it("requires restoration for an unknown remote key and authenticates its encrypted root", async () => {
        existingCloudProfile();
        const remote = await createCloudKeyBundle(cloudKeyInput.encryptionKey);
        vi.mocked(CloudWorkOS.prototype.getVaultIdentity).mockResolvedValue(remote.identityKey);
        vi.spyOn(CloudWorkOS.prototype, "restoreVault").mockResolvedValue({
            blob: remote.bundle,
            identityKey: remote.identityKey,
        });
        const { database, module } = await fixture("cloud-module-restore-keys");

        await connect(module, database);
        await waitForCloud(module, database, { keys: { status: "restore_required" } });
        const ready = await module.restoreKeys(database.context, cloudKeyInput);

        expect(ready.keys).toEqual({ identityKey: remote.identityKey, status: "ready" });
        await expect(
            createCloudKeysDatabase().read(database.context, {
                environment: "production",
                userId: user.id,
            }),
        ).resolves.toEqual({
            generatedSecret: cloudKeyInput.generatedSecret,
            identityKey: remote.identityKey,
            rootSecret: remote.rootSecret,
            status: "ready",
        });
        await expect(module.getKeyBackup(database.context)).resolves.toEqual({
            generatedSecret: cloudKeyInput.generatedSecret,
            rootSecret: remote.rootSecret,
        });
    });

    it("resets only restore-required vaults and preserves retained backup identity", async () => {
        existingCloudProfile();
        const saveVault = vi.spyOn(CloudWorkOS.prototype, "saveVault").mockResolvedValue(undefined);
        let finishDelete!: () => void;
        const deleteVault = vi.spyOn(CloudWorkOS.prototype, "deleteVault").mockImplementation(
            async () =>
                await new Promise<void>((resolve) => {
                    finishDelete = resolve;
                }),
        );
        const { database, module } = await fixture("cloud-module-reset-vault");

        await expect(
            module.deleteKeys(database.context, deleteCloudKeysInput),
        ).rejects.toMatchObject({
            code: "cloud_not_authenticated",
            status: 409,
        });
        await connect(module, database);
        await waitForCloud(module, database, { keys: { status: "create_required" } });
        await expect(
            module.deleteKeys(database.context, deleteCloudKeysInput),
        ).rejects.toMatchObject({
            code: "conflict",
            status: 409,
        });
        const ready = await module.createKeys(database.context, cloudKeyInput);
        if (ready.keys?.status !== "ready") throw new Error("Expected ready Cloud keys.");
        const originalIdentity = ready.keys.identityKey;
        const backup = await module.getKeyBackup(database.context);
        const stored = await createCloudDatabase().read(database.context);
        if (stored?.session === null || stored?.session === undefined) {
            throw new Error("Expected a connected Cloud session.");
        }
        await createCloudDatabase().replace(database.context, {
            error: null,
            pending: false,
            session: { ...stored.session, keys: { status: "restore_required" } },
        });
        await expect(module.getKeyBackup(database.context)).resolves.toEqual(backup);

        const deleting = module.deleteKeys(database.context, deleteCloudKeysInput);
        await vi.waitFor(() => expect(deleteVault).toHaveBeenCalledWith("access-b"));
        expect(module.status(database.context).keys).toEqual({ status: "resetting" });
        finishDelete();

        await expect(deleting).resolves.toMatchObject({ keys: { status: "create_required" } });
        await expect(module.getKeyBackup(database.context)).resolves.toEqual(backup);
        const recreated = await module.createKeys(database.context, cloudKeyInput);
        expect(recreated.keys).toEqual({ identityKey: originalIdentity, status: "ready" });
        expect(saveVault).toHaveBeenLastCalledWith(
            expect.any(String),
            cloudKeyInput.authHash,
            originalIdentity,
            expect.any(String),
        );
    });

    it("recovers an unfinished durable vault reset after restart", async () => {
        existingCloudProfile();
        vi.mocked(CloudWorkOS.prototype.getVaultIdentity).mockResolvedValue("unknown-vault-key");
        const deleteVault = vi
            .spyOn(CloudWorkOS.prototype, "deleteVault")
            .mockRejectedValue(new Error("network unavailable"));
        const { database, durableFunctions, module, profile } = await fixture(
            "cloud-module-reset-vault-recovery",
        );
        await connect(module, database);
        await waitForCloud(module, database, { keys: { status: "restore_required" } });

        const deleting = module
            .deleteKeys(database.context, deleteCloudKeysInput)
            .catch((error: unknown) => error);
        await vi.waitFor(() => expect(deleteVault).toHaveBeenCalled());
        await waitForCloud(module, database, { keys: { status: "resetting" } });
        await vi.waitFor(async () => expect(await pendingDurableCallCount(database)).toBe(1));

        await module.stop();
        durableFunctions.stop();
        await expect(deleting).resolves.toBeInstanceOf(Error);
        deleteVault.mockResolvedValue(undefined);

        const restartedDurableFunctions = new DurableFunctionsModule();
        const restarted = new CloudModule(restartedDurableFunctions, profile);
        modules.push({
            cloud: restarted,
            durableFunctions: restartedDurableFunctions,
            profile,
        });
        await resolveModuleHooks(database.context, restarted);
        const durableHooks = await resolveModuleHooks(database.context, restartedDurableFunctions);
        await durableHooks.afterStart?.(database.context, {} as never);

        await waitForCloud(restarted, database, { keys: { status: "create_required" } });
        await vi.waitFor(async () => expect(await pendingDurableCallCount(database)).toBe(0));
    });

    it("returns a rejected remote vault reset to restore-required", async () => {
        existingCloudProfile();
        vi.mocked(CloudWorkOS.prototype.getVaultIdentity).mockResolvedValue("unknown-vault-key");
        vi.spyOn(CloudWorkOS.prototype, "deleteVault").mockRejectedValue(
            new CloudVaultDeleteRejectedError(),
        );
        const { database, module } = await fixture("cloud-module-reset-vault-rejected");
        await connect(module, database);
        await waitForCloud(module, database, { keys: { status: "restore_required" } });

        await expect(
            module.deleteKeys(database.context, deleteCloudKeysInput),
        ).rejects.toMatchObject({ code: "conflict", status: 409 });
        expect(module.status(database.context).keys).toEqual({ status: "restore_required" });
    });

    it("fails backup reads generically for incomplete pre-retention key rows", async () => {
        existingCloudProfile();
        vi.spyOn(CloudWorkOS.prototype, "saveVault").mockResolvedValue(undefined);
        const { database, module } = await fixture("cloud-module-incomplete-key-backup");

        await expect(module.getKeyBackup(database.context)).rejects.toMatchObject({
            code: "cloud_not_authenticated",
            status: 409,
        });
        await connect(module, database);
        await waitForCloud(module, database, { keys: { status: "create_required" } });
        await expect(module.getKeyBackup(database.context)).rejects.toMatchObject({
            code: "conflict",
            status: 409,
        });
        await module.createKeys(database.context, cloudKeyInput);
        const account = { environment: "production", userId: user.id } as const;
        const local = await createCloudKeysDatabase().read(database.context, account);
        if (local?.status !== "ready") throw new Error("The fixture did not commit Cloud keys.");
        await createCloudKeysDatabase().write(database.context, account, {
            identityKey: local.identityKey,
            rootSecret: local.rootSecret,
            status: "ready",
        });

        const error = await module
            .getKeyBackup(database.context)
            .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(CloudOperationError);
        expect(error).toMatchObject({ message: "The stored Cloud key backup is incomplete." });
    });

    it("opens the fixed relay with an account-scoped durable Murmur store once keys are ready", async () => {
        existingCloudProfile();
        const sync = vi.fn((_ctx: Context, { abort }: { readonly abort: AbortSignal }) => {
            return new Promise<void>((resolve) => abort.addEventListener("abort", () => resolve()));
        });
        const close = vi.fn();
        const open = vi.spyOn(MurmurClient, "open").mockResolvedValue({ close, sync } as never);
        vi.spyOn(CloudWorkOS.prototype, "saveVault").mockResolvedValue(undefined);
        const { cloudHooks, database, module } = await fixture("cloud-module-murmur");
        await connect(module, database, "staging");
        await waitForCloud(module, database, { keys: { status: "create_required" } });
        await module.createKeys(database.context, cloudKeyInput);

        await cloudHooks.afterStart?.(database.context, {} as never);
        await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));

        expect(open).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                sessionProvider: expect.any(HttpRelaySessionProvider),
                store: expect.any(CloudMurmurStore),
            }),
        );
        expect(open.mock.calls[0]?.[1]).not.toHaveProperty("relay");
        expect(sync).toHaveBeenCalledTimes(1);
    });

    it("projects encrypted owner metadata and removes only sibling devices", async () => {
        existingCloudProfile();
        const currentKey = new Uint8Array(32).fill(11);
        const siblingKey = new Uint8Array(32).fill(12);
        let entries: MurmurDeviceRosterEntry[] = [];
        const removeDevice = vi.fn(async (_ctx: Context, deviceKey: Uint8Array) => {
            entries = entries.filter(
                (entry) => !Buffer.from(entry.deviceKey).equals(Buffer.from(deviceKey)),
            );
        });
        const sync = vi.fn((_ctx: Context, { abort }: { readonly abort: AbortSignal }) => {
            return new Promise<void>((resolve) => abort.addEventListener("abort", () => resolve()));
        });
        vi.spyOn(MurmurClient, "open").mockImplementation(
            async (ctx: Context, options: MurmurClientOptions) => {
                const accountKey = options.identity!.publicKey.slice();
                entries = [
                    {
                        deviceKey: currentKey,
                        encryptedMetadata: await options.encryptDeviceMetadata!(ctx, currentKey),
                        lastAccessedAt: 1_755_400_000_000,
                        resetGeneration: 0,
                    },
                    {
                        deviceKey: siblingKey,
                        encryptedMetadata: await options.encryptDeviceMetadata!(ctx, siblingKey),
                        lastAccessedAt: 1_755_400_001_000,
                        resetGeneration: 0,
                    },
                ];
                return {
                    get accountKey() {
                        return accountKey.slice();
                    },
                    close: vi.fn(),
                    get deviceKey() {
                        return currentKey.slice();
                    },
                    devices: vi.fn(async () => entries),
                    removeDevice,
                    sync,
                } as never;
            },
        );
        vi.spyOn(CloudWorkOS.prototype, "saveVault").mockResolvedValue(undefined);
        const { cloudHooks, database, module } = await fixture("cloud-module-devices");
        await connect(module, database, "staging");
        await waitForCloud(module, database, { keys: { status: "create_required" } });
        await module.createKeys(database.context, cloudKeyInput);
        await cloudHooks.afterStart?.(database.context, {} as never);
        await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1));

        const currentId = Buffer.from(currentKey).toString("base64url");
        const siblingId = Buffer.from(siblingKey).toString("base64url");
        await expect(module.getDevices(database.context)).resolves.toEqual({
            devices: [
                expect.objectContaining({
                    current: true,
                    id: currentId,
                    metadata: expect.objectContaining({
                        agentVersion: "development",
                        installationId: "test-instance",
                    }),
                }),
                expect.objectContaining({ current: false, id: siblingId }),
            ],
        });
        await expect(module.removeDevice(database.context, siblingId)).resolves.toEqual({
            devices: [expect.objectContaining({ current: true, id: currentId })],
        });
        expect(removeDevice).toHaveBeenCalledOnce();
        await expect(module.removeDevice(database.context, siblingId)).resolves.toEqual({
            devices: [expect.objectContaining({ current: true, id: currentId })],
        });
        expect(removeDevice).toHaveBeenCalledOnce();
        await expect(module.removeDevice(database.context, currentId)).rejects.toMatchObject({
            code: "conflict",
            devices: [expect.objectContaining({ current: true, id: currentId })],
            status: 409,
        });
    });

    it("durably deletes local keys and Murmur state when Cloud disconnects", async () => {
        existingCloudProfile();
        const sync = vi.fn((_ctx: Context, { abort }: { readonly abort: AbortSignal }) => {
            return new Promise<void>((resolve) => abort.addEventListener("abort", () => resolve()));
        });
        const liveClose = vi.fn();
        const cleanupClose = vi.fn();
        const deviceKey = new Uint8Array(32).fill(7);
        const removeDevice = vi.fn().mockResolvedValue(undefined);
        const open = vi
            .spyOn(MurmurClient, "open")
            .mockResolvedValueOnce({ close: liveClose, sync } as never)
            .mockResolvedValueOnce({
                close: cleanupClose,
                deviceKey,
                removeDevice,
            } as never);
        vi.spyOn(CloudWorkOS.prototype, "saveVault").mockResolvedValue(undefined);
        const { cloudHooks, database, durableFunctions, module, profile } = await fixture(
            "cloud-module-disconnect-deletes-account",
        );
        const account = { environment: "production", userId: user.id } as const;
        const murmurStore = new CloudMurmurStore(database.database, account);

        await connect(module, database);
        await waitForCloud(module, database, { keys: { status: "create_required" } });
        await module.createKeys(database.context, cloudKeyInput);
        await murmurStore.set(database.context, "device/key", new Uint8Array([1, 2, 3]));
        await cloudHooks.afterStart?.(database.context, {} as never);
        await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1));

        await expect(module.disconnect(database.context)).resolves.toMatchObject({
            status: "disconnected",
        });
        expect(liveClose).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(removeDevice).toHaveBeenCalledTimes(1));
        expect(removeDevice).toHaveBeenCalledWith(expect.anything(), deviceKey);
        expect(cleanupClose).toHaveBeenCalledTimes(1);
        expect(open.mock.calls[1]?.[1]).toEqual(
            expect.objectContaining({ sessionProvider: expect.any(HttpRelaySessionProvider) }),
        );
        expect(open.mock.calls[1]?.[1]).not.toHaveProperty("relay");
        await expect(
            createCloudKeysDatabase().read(database.context, account),
        ).resolves.toBeUndefined();
        await expect(murmurStore.get(database.context, "device/key")).resolves.toBeUndefined();

        await module.stop();
        durableFunctions.stop();
        const restartedDurableFunctions = new DurableFunctionsModule();
        const restarted = new CloudModule(restartedDurableFunctions, profile);
        modules.push({
            cloud: restarted,
            durableFunctions: restartedDurableFunctions,
            profile,
        });
        await resolveModuleHooks(database.context, restarted);
        expect(restarted.status(database.context)).toMatchObject({ status: "disconnected" });
        await expect(
            createCloudKeysDatabase().read(database.context, account),
        ).resolves.toBeUndefined();
        await expect(murmurStore.get(database.context, "device/key")).resolves.toBeUndefined();
    });

    it("retries Murmur device removal after restart before deleting local secrets", async () => {
        existingCloudProfile();
        const sync = vi.fn((_ctx: Context, { abort }: { readonly abort: AbortSignal }) => {
            return new Promise<void>((resolve) => abort.addEventListener("abort", () => resolve()));
        });
        const deviceKey = new Uint8Array(32).fill(8);
        const removeDevice = vi
            .fn()
            .mockRejectedValueOnce(new Error("relay unavailable"))
            .mockResolvedValue(undefined);
        const open = vi
            .spyOn(MurmurClient, "open")
            .mockResolvedValueOnce({ close: vi.fn(), sync } as never)
            .mockResolvedValue({
                close: vi.fn(),
                deviceKey,
                removeDevice,
            } as never);
        vi.spyOn(CloudWorkOS.prototype, "saveVault").mockResolvedValue(undefined);
        const { cloudHooks, database, durableFunctions, module, profile } = await fixture(
            "cloud-module-disconnect-recovery",
        );
        const account = { environment: "production", userId: user.id } as const;
        const murmurStore = new CloudMurmurStore(database.database, account);

        await connect(module, database);
        await waitForCloud(module, database, { keys: { status: "create_required" } });
        await module.createKeys(database.context, cloudKeyInput);
        await murmurStore.set(database.context, "device/key", new Uint8Array([4, 5, 6]));
        await cloudHooks.afterStart?.(database.context, {} as never);
        await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
        await module.disconnect(database.context);
        await vi.waitFor(() => expect(removeDevice).toHaveBeenCalledTimes(1));

        await expect(
            createCloudKeysDatabase().read(database.context, account),
        ).resolves.toMatchObject({
            status: "ready",
        });
        await expect(murmurStore.get(database.context, "device/key")).resolves.toEqual(
            new Uint8Array([4, 5, 6]),
        );
        await expect(
            module.start(database.context, {
                environment: "production",
                redirectUri: "happy-auth://callback",
            }),
        ).rejects.toMatchObject({ code: "conflict", status: 409 });
        expect(await pendingDurableCallCount(database)).toBe(1);
        const [disconnectCall] = await pendingDurableCalls(database, "cloud.disconnect");
        expect(JSON.parse(disconnectCall!.arguments_json)).toEqual({
            environment: "production",
            generation: expect.any(String),
            userId: user.id,
        });
        expect(disconnectCall!.arguments_json).not.toContain("refresh-");

        await module.stop();
        durableFunctions.stop();
        open.mockClear();
        const restartedDurableFunctions = new DurableFunctionsModule();
        const restarted = new CloudModule(restartedDurableFunctions, profile);
        modules.push({
            cloud: restarted,
            durableFunctions: restartedDurableFunctions,
            profile,
        });
        await resolveModuleHooks(database.context, restarted);
        const durableHooks = await resolveModuleHooks(database.context, restartedDurableFunctions);
        await durableHooks.afterStart?.(database.context, {} as never);

        await vi.waitFor(() => expect(removeDevice).toHaveBeenCalledTimes(2));
        await vi.waitFor(async () => {
            expect(await createCloudKeysDatabase().read(database.context, account)).toBeUndefined();
            expect(await murmurStore.get(database.context, "device/key")).toBeUndefined();
            expect(await pendingDurableCallCount(database)).toBe(0);
        });
        expect(restarted.status(database.context)).toMatchObject({ status: "disconnected" });
    });

    it("deletes local secrets after the durable Murmur unregister budget is exhausted", async () => {
        existingCloudProfile();
        const logs: CloudLogRecord[] = [];
        const deviceKey = new Uint8Array(32).fill(9);
        const relayFailure = new Error("relay unavailable");
        const removeDevice = vi.fn().mockRejectedValue(relayFailure);
        vi.spyOn(MurmurClient, "open").mockResolvedValue({
            close: vi.fn(),
            deviceKey,
            removeDevice,
        } as never);
        vi.spyOn(CloudWorkOS.prototype, "saveVault").mockResolvedValue(undefined);
        const { database, module } = await fixture(
            "cloud-module-disconnect-unregister-budget",
            logs,
        );
        const account = { environment: "production", userId: user.id } as const;
        const murmurStore = new CloudMurmurStore(database.database, account);

        await connect(module, database);
        await waitForCloud(module, database, { keys: { status: "create_required" } });
        await module.createKeys(database.context, cloudKeyInput);
        await murmurStore.set(database.context, "device/key", new Uint8Array([7, 8, 9]));
        await module.disconnect(database.context);

        await vi.waitFor(
            async () => {
                expect(removeDevice).toHaveBeenCalledTimes(3);
                expect(
                    await createCloudKeysDatabase().read(database.context, account),
                ).toBeUndefined();
                expect(await murmurStore.get(database.context, "device/key")).toBeUndefined();
                expect(await pendingDurableCallCount(database)).toBe(0);
            },
            { timeout: 15_000 },
        );
        expect(logs).toContainEqual(
            expect.objectContaining({
                level: "warn",
                message: expect.stringContaining(
                    "phase=murmur-unregister reason=retry-exhausted deviceMayRemainRegistered=true",
                ),
            }),
        );
        expect(logs).toContainEqual(
            expect.objectContaining({
                error: relayFailure,
                level: "warn",
                message: expect.stringContaining("phase=murmur-unregister"),
            }),
        );
    }, 20_000);

    it("deletes recognized legacy local identity state without retrying Murmur removal", async () => {
        existingCloudProfile();
        const open = vi.spyOn(MurmurClient, "open");
        vi.spyOn(CloudWorkOS.prototype, "saveVault").mockResolvedValue(undefined);
        const { database, module } = await fixture("cloud-module-disconnect-legacy-identity");
        const account = { environment: "production", userId: user.id } as const;
        const keysDatabase = createCloudKeysDatabase();
        const murmurStore = new CloudMurmurStore(database.database, account);

        await connect(module, database);
        await waitForCloud(module, database, { keys: { status: "create_required" } });
        await module.createKeys(database.context, cloudKeyInput);
        const local = await keysDatabase.read(database.context, account);
        if (local?.status !== "ready") throw new Error("Expected ready Cloud keys.");
        const root = new Uint8Array(Buffer.from(local.rootSecret, "base64url"));
        const legacyIdentity = importIdentityKeyPair(root);
        try {
            await keysDatabase.write(database.context, account, {
                ...local,
                identityKey: Buffer.from(legacyIdentity.publicKey).toString("base64url"),
            });
        } finally {
            destroyIdentity(legacyIdentity);
            root.fill(0);
        }
        await murmurStore.set(database.context, "legacy/device", new Uint8Array([7, 8, 9]));

        await expect(module.disconnect(database.context)).resolves.toMatchObject({
            status: "disconnected",
        });
        await vi.waitFor(async () => {
            expect(await keysDatabase.read(database.context, account)).toBeUndefined();
            expect(await murmurStore.get(database.context, "legacy/device")).toBeUndefined();
            expect(await pendingDurableCallCount(database)).toBe(0);
        });
        expect(open).not.toHaveBeenCalled();
    });

    it("deletes local state from a pre-token disconnect record without contacting Murmur", async () => {
        existingCloudProfile();
        const open = vi.spyOn(MurmurClient, "open");
        vi.spyOn(CloudWorkOS.prototype, "saveVault").mockResolvedValue(undefined);
        const { database, durableFunctions, module, profile } = await fixture(
            "cloud-module-disconnect-missing-credential",
        );
        const account = { environment: "production", userId: user.id } as const;
        const murmurStore = new CloudMurmurStore(database.database, account);

        await connect(module, database);
        await waitForCloud(module, database, { keys: { status: "create_required" } });
        await module.createKeys(database.context, cloudKeyInput);
        await murmurStore.set(database.context, "device/key", new Uint8Array([7, 8, 9]));
        durableFunctions.stop();
        await module.disconnect(database.context);
        await agentDatabaseRun(
            database.context.db,
            sql`UPDATE happy_agent_cloud_disconnect SET refresh_token = NULL`,
        );

        await module.stop();
        const restartedDurableFunctions = new DurableFunctionsModule();
        const restarted = new CloudModule(restartedDurableFunctions, profile);
        modules.push({
            cloud: restarted,
            durableFunctions: restartedDurableFunctions,
            profile,
        });
        await resolveModuleHooks(database.context, restarted);
        const durableHooks = await resolveModuleHooks(database.context, restartedDurableFunctions);
        await durableHooks.afterStart?.(database.context, {} as never);

        await vi.waitFor(async () => {
            expect(await createCloudKeysDatabase().read(database.context, account)).toBeUndefined();
            expect(await murmurStore.get(database.context, "device/key")).toBeUndefined();
            expect(await pendingDurableCallCount(database)).toBe(0);
        });
        expect(open).not.toHaveBeenCalled();
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
        expect(connected.enrollment).toEqual({ status: "checking" });
        await waitForCloud(module, database, { enrollment: { status: "required" } });
        expect(await pendingDurableCallCount(database)).toBe(0);

        const minted = await module.mint(database.context);
        expect(minted.accessToken).toBe("access-b");
        expect(minted.cloud).toMatchObject({
            enrollment: { status: "required" },
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
        await waitForCloud(module, database, { enrollment: { status: "required" } });
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

        await expect(module.listOrganizations(database.context)).resolves.toEqual({
            organizations: [{ id: "org_existing", name: "Existing Team" }],
        });
        await expect(
            module.createOrganization(database.context, "Analytical Engines"),
        ).resolves.toEqual({ id: "org_created", name: "Analytical Engines" });
        await expect(
            module.deleteOrganization(database.context, "org_created"),
        ).resolves.toBeUndefined();

        expect(list).toHaveBeenCalledWith("organization-access-1");
        expect(create).toHaveBeenCalledWith("organization-access-2", "Analytical Engines");
        expect(remove).toHaveBeenCalledWith("organization-access-3", "org_created");
        expect((await createCloudDatabase().read(database.context))?.session?.refreshToken).toBe(
            "organization-refresh-3",
        );
    });

    it("rejects invalid and unauthorized organization mutations with display-safe errors", async () => {
        const { database, module } = await fixture("cloud-module-organization-errors");
        await connect(module, database);
        await waitForCloud(module, database, { enrollment: { status: "required" } });
        const create = vi.spyOn(CloudWorkOS.prototype, "createOrganization");
        const remove = vi
            .spyOn(CloudWorkOS.prototype, "deleteOrganization")
            .mockRejectedValue(new CloudOrganizationForbiddenError());

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
    });

    it("exposes authenticated Cloud storage reads and conditional writes", async () => {
        const { database, module } = await fixture("cloud-module-storage-values");
        const first = new Uint8Array([0, 1, 127, 128, 255]);
        const firstSha256 = "1".repeat(64);
        const firstVersion = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
        const second = new Uint8Array([9, 8, 7]);
        const secondSha256 = "2".repeat(64);
        const secondVersion = "01991f3a-5c1e-7001-8000-2f9a1b3c4d5e";
        vi.mocked(fetch).mockImplementation(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === "/v0/hello") {
                return Response.json({ message: "hello", userId: user.id });
            }
            expect(url.pathname).toBe("/v0/storage");
            expect(url.searchParams.get("key")).toBe("folder/binary key");
            if (init?.method === "GET") {
                return new Response(first, {
                    headers: {
                        "content-type": "application/octet-stream",
                        etag: `"${firstSha256}"`,
                        "x-happy-cloud-version": firstVersion,
                    },
                });
            }
            return Response.json(
                { sha256: secondSha256, version: secondVersion },
                {
                    headers: {
                        etag: `"${secondSha256}"`,
                        "x-happy-cloud-version": secondVersion,
                    },
                },
            );
        });
        await connect(module, database);

        await expect(module.readValue(database.context, "folder/binary key")).resolves.toEqual({
            sha256: firstSha256,
            value: first,
            version: firstVersion,
        });
        await expect(
            module.writeValue(database.context, "folder/binary key", second, {
                kind: "sha256",
                sha256: firstSha256,
            }),
        ).resolves.toEqual({ sha256: secondSha256, version: secondVersion });

        const storageCalls = vi
            .mocked(fetch)
            .mock.calls.filter(([input]) => new URL(String(input)).pathname === "/v0/storage");
        expect(storageCalls.map(([, init]) => init?.method)).toEqual(["GET", "PUT"]);
        expect(new Headers(storageCalls[1]?.[1]?.headers).get("if-match")).toBe(`"${firstSha256}"`);
        expect((await createCloudDatabase().read(database.context))?.session?.refreshToken).toBe(
            "refresh-b",
        );
    });

    it("maps a lost Cloud storage compare to a conflict with current metadata", async () => {
        const { database, module } = await fixture("cloud-module-storage-conflict");
        const current = {
            sha256: "3".repeat(64),
            version: "01991f3a-5c1e-7002-8000-2f9a1b3c4d5e",
        };
        vi.mocked(fetch).mockImplementation(async (input) => {
            const url = new URL(String(input));
            if (url.pathname === "/v0/hello") {
                return Response.json({ message: "hello", userId: user.id });
            }
            return Response.json(
                { error: "precondition_failed", ...current },
                {
                    headers: {
                        etag: `"${current.sha256}"`,
                        "x-happy-cloud-version": current.version,
                    },
                    status: 412,
                },
            );
        });
        await connect(module, database);

        await expect(
            module.writeValue(database.context, "state", new Uint8Array(), { kind: "empty" }),
        ).rejects.toMatchObject({
            code: "conflict",
            current,
            status: 409,
        } satisfies Partial<CloudStorageConflictError>);
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
        await waitForCloud(module, database, { enrollment: { status: "required" } });
        module.onUpdated(() => updates.push("cloud"));
        module.onProfileUpdated(() => updates.push("profile"));

        await expect(module.getProfile(database.context)).resolves.toEqual({
            enrollment: { status: "required" },
            profile: { firstName: null, username: null },
        });
        workos.refresh.mockResolvedValueOnce({
            accessToken: "access-c",
            refreshToken: "refresh-c",
            user: { ...user, firstName: "Changed upstream" },
        });
        await expect(
            module.enrollProfile(database.context, {
                mutationId: "profile-update",
                username: "ada_next",
            }),
        ).resolves.toEqual({
            enrollment: { status: "enrolling", username: "ada_next" },
            profile: { firstName: "Ada", username: "ada_next" },
        });

        await waitForCloud(module, database, {
            enrollment: { status: "enrolled", username: "ada_next" },
        });

        expect(workos.refresh).toHaveBeenCalled();
        expect((await createCloudDatabase().read(database.context))?.session?.refreshToken).toMatch(
            /^refresh-[bc]$/,
        );
        expect(module.status(database.context).user).toEqual({
            ...user,
            firstName: "Changed upstream",
        });
        expect(updates).toContain("profile");
    });

    it("activates friends on enrollment, hydrates mutation snapshots, and clears on disconnect", async () => {
        const { database, module } = await fixture("cloud-module-social");
        const remoteVersion = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
        const graceVersion = "01991f3a-5c1e-7001-8000-2f9a1b3c4d5e";
        const socialUpdates: Array<{ origin: string; status: string }> = [];
        module.onSocialUpdated((_ctx, social, origin) => {
            socialUpdates.push({ origin, status: social.status });
        });
        vi.mocked(fetch).mockImplementation(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v0/hello") {
                return Response.json({ message: "hello", userId: user.id });
            }
            if (path === "/v0/profile") {
                return Response.json({ firstName: "Ada", username: "ada" });
            }
            if (path === "/v0/friends/requests/grace" && init?.method === "PUT") {
                return Response.json({ status: "pending" });
            }
            if (path === "/v0/friends") {
                return Response.json({
                    friends: [{ firstName: "stale", username: "grace" }],
                    version: remoteVersion,
                });
            }
            if (path === "/v0/friends/requests") {
                return Response.json({ incoming: [], outgoing: [], version: remoteVersion });
            }
            if (path === "/v0/friends/blocked") {
                return Response.json({ blocked: [], version: remoteVersion });
            }
            if (path === "/v0/profiles/grace") {
                return Response.json({
                    firstName: "Grace",
                    lastName: "Hopper",
                    username: "grace",
                    version: graceVersion,
                });
            }
            return Response.json({ error: "not_found" }, { status: 404 });
        });
        await connect(module, database);

        await module.enrollProfile(database.context, { username: "ada" });
        await vi.waitFor(() => {
            expect(module.socialStatus(database.context)).toMatchObject({
                connection: "connecting",
                status: "enrolled",
            });
        });

        await expect(
            module.mutateSocial(database.context, "send-request", "grace"),
        ).resolves.toMatchObject({
            cloudSocial: {
                connection: "connecting",
                friends: [
                    {
                        firstName: "Grace",
                        lastName: "Hopper",
                        username: "grace",
                        version: graceVersion,
                    },
                ],
                status: "enrolled",
            },
        });

        await module.disconnect(database.context);
        expect(module.socialStatus(database.context)).toMatchObject({
            blocked: [],
            connection: null,
            friends: [],
            status: "unenrolled",
        });
        expect(socialUpdates).toEqual([
            { origin: "background", status: "enrolled" },
            { origin: "mutation", status: "enrolled" },
            { origin: "mutation", status: "unenrolled" },
        ]);
    });

    it("opens the updates socket only after enrollment and durably converges its announced state", async () => {
        const { cloudHooks, database, module } = await fixture("cloud-module-social-socket");
        const remoteVersion = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
        const graceVersion = "01991f3a-5c1e-7001-8000-2f9a1b3c4d5e";
        const open = vi.spyOn(CloudWorkOS.prototype, "openSocialSocket");
        open.mockImplementation(async (_token, signal, callbacks) => {
            let finish: (() => void) | undefined;
            const done = new Promise<void>((resolve) => {
                finish = resolve;
            });
            signal.addEventListener("abort", () => finish?.(), { once: true });
            await callbacks.onState(remoteVersion);
            return { close: () => finish?.(), done };
        });
        vi.spyOn(CloudWorkOS.prototype, "getSocialSnapshot").mockResolvedValue({
            blocked: [],
            friends: [{ firstName: "Grace", username: "grace", version: graceVersion }],
            incomingRequests: [],
            outgoingRequests: [],
            version: remoteVersion,
        });
        vi.mocked(fetch).mockImplementation(async (input) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v0/hello") {
                return Response.json({ message: "hello", userId: user.id });
            }
            return Response.json({ firstName: "Ada", username: "ada" });
        });

        await cloudHooks.afterStart?.(database.context, {} as never);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(open).not.toHaveBeenCalled();
        await connect(module, database);
        await module.enrollProfile(database.context, { username: "ada" });

        await vi.waitFor(() => {
            expect(module.socialStatus(database.context)).toMatchObject({
                connection: "connected",
                friends: [{ username: "grace", version: graceVersion }],
                status: "enrolled",
            });
        });
        expect(open).toHaveBeenCalledTimes(1);
    });

    it("requires a compatible local profile name before contacting Cloud enrollment", async () => {
        const { database, module, profile } = await fixture("cloud-module-profile-name-required");
        const local = await profile.get(database.context);
        if (local === undefined) throw new Error("Expected a local profile.");
        await profile.update(database.context, local.id, { name: null });
        await connect(module, database);
        workos.refresh.mockClear();
        vi.mocked(fetch).mockClear();

        await expect(
            module.enrollProfile(database.context, { username: "ada" }),
        ).rejects.toMatchObject({ code: "conflict", status: 409 });
        expect(workos.refresh).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    it("keeps identity out of profiles when keys become ready", async () => {
        const { database, module } = await fixture("cloud-module-profile-key-sync");
        vi.mocked(CloudWorkOS.prototype.getProfileState).mockRestore();
        let online: Record<string, unknown> = { firstName: "Ada", username: "ada" };
        const profileWrites: Array<Record<string, unknown>> = [];
        vi.mocked(fetch).mockImplementation(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v0/hello") {
                return Response.json({ message: "hello", userId: user.id });
            }
            if (path === "/v0/profile" && init?.method === "PUT") {
                online = JSON.parse(String(init.body)) as Record<string, unknown>;
                profileWrites.push(online);
            }
            return Response.json(online);
        });
        const saveVault = vi.spyOn(CloudWorkOS.prototype, "saveVault").mockResolvedValue(undefined);
        await connect(module, database);

        await module.enrollProfile(database.context, { username: "ada" });
        await vi.waitFor(() => {
            expect(profileWrites).toEqual([{ firstName: "Ada", username: "ada" }]);
        });
        await waitForCloud(module, database, { keys: { status: "create_required" } });
        const ready = await module.createKeys(database.context, cloudKeyInput);
        if (ready.keys?.status !== "ready") throw new Error("Expected ready Cloud keys.");
        const identityKey = ready.keys.identityKey;

        expect(profileWrites).toEqual([{ firstName: "Ada", username: "ada" }]);
        expect(saveVault).toHaveBeenCalledWith(
            expect.any(String),
            cloudKeyInput.authHash,
            identityKey,
            expect.any(String),
        );
        await expect(createCloudDatabase().read(database.context)).resolves.toMatchObject({
            session: {
                enrollment: { status: "enrolled", username: "ada" },
            },
        });
    });

    it("durably synchronizes later local profile names while preserving the Cloud username", async () => {
        const { database, module, profile } = await fixture("cloud-module-profile-sync");
        vi.mocked(CloudWorkOS.prototype.getProfileState).mockRestore();
        let online = { firstName: "Ada", username: "ada" };
        const profileWrites: Array<Record<string, unknown>> = [];
        vi.mocked(fetch).mockImplementation(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === "/v0/hello") {
                return Response.json({ message: "hello", userId: user.id });
            }
            if (init?.method === "PUT") {
                const body = JSON.parse(String(init.body)) as {
                    firstName: string;
                    username: string;
                };
                profileWrites.push(body);
                online = body;
            }
            return Response.json(online);
        });
        await connect(module, database);
        await module.enrollProfile(database.context, { username: "ada" });
        await waitForCloud(module, database, {
            enrollment: { status: "enrolled", username: "ada" },
        });
        const local = await profile.get(database.context);
        if (local === undefined) throw new Error("Expected a local profile.");

        const changed = await profile.update(database.context, local.id, { name: "Grace Hopper" });
        if (changed === undefined) throw new Error("Expected the profile update to succeed.");

        await vi.waitFor(async () => {
            expect(
                (await createCloudDatabase().read(database.context))?.session?.enrollment,
            ).toEqual({
                profileVersion: changed.version,
                status: "enrolled",
                username: "ada",
            });
        });
        expect(online).toEqual({ firstName: "Grace Hopper", username: "ada" });
        expect(profileWrites).toEqual([
            { firstName: "Ada", username: "ada" },
            { firstName: "Grace Hopper", username: "ada" },
        ]);
    });

    it("reconciles the online enrollment on restart before syncing the local profile back", async () => {
        const { database, durableFunctions, module, profile } = await fixture(
            "cloud-module-profile-reconcile",
        );
        vi.mocked(CloudWorkOS.prototype.getProfileState).mockRestore();
        let online: { firstName: string; lastName?: string; username: string } = {
            firstName: "Ada",
            username: "ada",
        };
        const profileWrites: Array<Record<string, unknown>> = [];
        vi.mocked(fetch).mockImplementation(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === "/v0/hello") {
                return Response.json({ message: "hello", userId: user.id });
            }
            if (init?.method === "PUT") {
                const body = JSON.parse(String(init.body)) as {
                    firstName: string;
                    username: string;
                };
                profileWrites.push(body);
                online = body;
            }
            return Response.json(online);
        });
        await connect(module, database);
        await module.enrollProfile(database.context, { username: "ada" });
        await waitForCloud(module, database, {
            enrollment: { status: "enrolled", username: "ada" },
        });
        await module.stop();
        durableFunctions.stop();
        online = { firstName: "Remote name", lastName: "Remote surname", username: "ada_online" };

        const restartedDurableFunctions = new DurableFunctionsModule();
        const restarted = new CloudModule(restartedDurableFunctions, profile);
        modules.push({
            cloud: restarted,
            durableFunctions: restartedDurableFunctions,
            profile,
        });
        await resolveModuleHooks(database.context, restarted);
        const durableHooks = await resolveModuleHooks(database.context, restartedDurableFunctions);
        await durableHooks.afterStart?.(database.context, {} as never);
        const local = await profile.get(database.context);
        if (local === undefined) throw new Error("Expected a local profile.");

        await vi.waitFor(async () => {
            expect(
                (await createCloudDatabase().read(database.context))?.session?.enrollment,
            ).toEqual({
                profileVersion: local.version,
                status: "enrolled",
                username: "ada_online",
            });
        });
        expect(online).toEqual({ firstName: "Ada", username: "ada_online" });
        expect(profileWrites.at(-1)).toEqual({ firstName: "Ada", username: "ada_online" });
    });

    it("rejects an invalid enrollment username before refreshing or contacting Cloud", async () => {
        const { database, module } = await fixture("cloud-module-profile-validation");
        await connect(module, database);
        workos.refresh.mockClear();
        vi.mocked(fetch).mockClear();

        await expect(
            module.enrollProfile(database.context, { username: "UPPERCASE" }),
        ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
        expect(workos.refresh).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    it("returns immediately and durably settles an unavailable username as required", async () => {
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
            module.enrollProfile(database.context, { username: "taken_name" }),
        ).resolves.toEqual({
            enrollment: { status: "enrolling", username: "taken_name" },
            profile: { firstName: "Ada", username: "taken_name" },
        });
        await waitForCloud(module, database, { enrollment: { status: "required" } });
        expect((await createCloudDatabase().read(database.context))?.session?.refreshToken).toBe(
            "refresh-b",
        );
        expect(module.status(database.context).user).toEqual(user);
        expect(updates).toHaveLength(2);
        expect(profileUpdates).toEqual([]);
    });

    it("does not let a stale username rejection cancel a newer durable intent", async () => {
        const { database, module } = await fixture("cloud-module-enrollment-replacement");
        await connect(module, database);
        await waitForCloud(module, database, { enrollment: { status: "required" } });
        let rejectFirst!: (error: unknown) => void;
        const updateProfile = vi
            .spyOn(CloudWorkOS.prototype, "updateProfile")
            .mockImplementationOnce(
                async () =>
                    await new Promise((_, reject) => {
                        rejectFirst = reject;
                    }),
            )
            .mockResolvedValue({ firstName: "Ada", username: "ada_two" });

        await module.enrollProfile(database.context, { username: "ada_one" });
        await vi.waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
        await module.enrollProfile(database.context, { username: "ada_two" });
        await vi.waitFor(async () => {
            const calls = await pendingDurableCalls(database, "cloud.reconcile-enrollment");
            expect(calls).toHaveLength(2);
            expect(calls.every((call) => call.operation_id === null)).toBe(true);
            expect(calls.every((call) => call.lock_keys_json === "[]")).toBe(true);
        });
        rejectFirst(new CloudUsernameUnavailableError());

        await waitForCloud(module, database, {
            enrollment: { status: "enrolled", username: "ada_two" },
        });
        expect(updateProfile).toHaveBeenLastCalledWith(
            expect.any(String),
            expect.objectContaining({ username: "ada_two" }),
        );
    });

    it("gives re-enrollment a new transactional key-discovery generation", async () => {
        existingCloudProfile();
        const finishDiscoveries: Array<(identityKey: string | undefined) => void> = [];
        vi.mocked(CloudWorkOS.prototype.getVaultIdentity).mockImplementation(
            async () =>
                await new Promise((resolve) => {
                    finishDiscoveries.push(resolve);
                }),
        );
        vi.spyOn(CloudWorkOS.prototype, "updateProfile").mockResolvedValue({
            firstName: "Ada",
            username: "ada_two",
        });
        const { database, module } = await fixture("cloud-module-key-discovery-generation");

        await connect(module, database);
        await waitForCloud(module, database, { enrollment: { status: "enrolled" } });
        await vi.waitFor(async () => {
            expect(await pendingDurableCalls(database, "cloud.reconcile-keys")).toHaveLength(1);
        });

        await module.enrollProfile(database.context, { username: "ada_two" });
        await waitForCloud(module, database, {
            enrollment: { status: "enrolled", username: "ada_two" },
        });
        await vi.waitFor(async () => {
            const calls = await pendingDurableCalls(database, "cloud.reconcile-keys");
            expect(calls).toHaveLength(2);
            expect(calls.every((call) => call.operation_id === null)).toBe(true);
            expect(calls.every((call) => call.lock_keys_json === "[]")).toBe(true);
            expect(finishDiscoveries).toHaveLength(2);
        });

        for (const finishDiscovery of finishDiscoveries) {
            finishDiscovery(undefined);
        }
        await waitForCloud(module, database, { keys: { status: "create_required" } });
    });

    it("schedules profile convergence when the local name changes during enrollment", async () => {
        const { database, module, profile } = await fixture("cloud-module-enrollment-profile-race");
        await connect(module, database);
        await waitForCloud(module, database, { enrollment: { status: "required" } });
        let finishFirst!: (profile: {
            readonly firstName: string;
            readonly username: string;
        }) => void;
        const updateProfile = vi
            .spyOn(CloudWorkOS.prototype, "updateProfile")
            .mockImplementationOnce(
                async () =>
                    await new Promise((resolve) => {
                        finishFirst = resolve;
                    }),
            )
            .mockImplementation(async (_token, request) => ({
                firstName: request.firstName,
                username: request.username,
            }));

        await module.enrollProfile(database.context, { username: "ada" });
        await vi.waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
        const local = await profile.get(database.context);
        if (local === undefined) throw new Error("Expected a local profile.");
        const changed = await profile.update(database.context, local.id, { name: "Grace Hopper" });
        if (changed === undefined) throw new Error("Expected the local profile change to succeed.");
        vi.mocked(CloudWorkOS.prototype.getProfileState).mockResolvedValue({
            profile: { firstName: "Ada", username: "ada" },
        });
        finishFirst({ firstName: "Ada", username: "ada" });

        await vi.waitFor(() => {
            expect(updateProfile).toHaveBeenLastCalledWith(
                expect.any(String),
                expect.objectContaining({ firstName: "Grace Hopper", username: "ada" }),
            );
        });
        await vi.waitFor(async () => {
            expect(
                (await createCloudDatabase().read(database.context))?.session?.enrollment,
            ).toMatchObject({ profileVersion: changed.version, status: "enrolled" });
        });
    });

    it("recovers a queued username enrollment after the daemon restarts", async () => {
        const { database, durableFunctions, module, profile } = await fixture(
            "cloud-module-enrollment-recovery",
        );
        await connect(module, database);
        await waitForCloud(module, database, { enrollment: { status: "required" } });
        const updateProfile = vi
            .spyOn(CloudWorkOS.prototype, "updateProfile")
            .mockRejectedValue(new Error("network unavailable"));

        await expect(
            module.enrollProfile(database.context, { username: "ada" }),
        ).resolves.toMatchObject({ enrollment: { status: "enrolling", username: "ada" } });
        await vi.waitFor(() => expect(updateProfile).toHaveBeenCalled());
        expect(await pendingDurableCallCount(database)).toBe(1);

        await module.stop();
        durableFunctions.stop();
        updateProfile.mockResolvedValue({ firstName: "Ada", username: "ada" });

        const restartedDurableFunctions = new DurableFunctionsModule();
        const restarted = new CloudModule(restartedDurableFunctions, profile);
        modules.push({
            cloud: restarted,
            durableFunctions: restartedDurableFunctions,
            profile,
        });
        await resolveModuleHooks(database.context, restarted);
        const durableHooks = await resolveModuleHooks(database.context, restartedDurableFunctions);
        await durableHooks.afterStart?.(database.context, {} as never);

        await waitForCloud(restarted, database, {
            enrollment: { status: "enrolled", username: "ada" },
        });
        await vi.waitFor(async () => expect(await pendingDurableCallCount(database)).toBe(0));
    });

    it("recovers key setup without persisting factors and requires their re-entry", async () => {
        existingCloudProfile();
        const { database, durableFunctions, module, profile } = await fixture(
            "cloud-module-key-factor-recovery",
        );
        await connect(module, database);
        await waitForCloud(module, database, { keys: { status: "create_required" } });
        const saveVault = vi
            .spyOn(CloudWorkOS.prototype, "saveVault")
            .mockRejectedValue(new Error("network unavailable"));

        const creating = module
            .createKeys(database.context, cloudKeyInput)
            .catch((error: unknown) => error);
        await vi.waitFor(() => expect(saveVault).toHaveBeenCalled());
        const calls = await agentDatabaseRows<{ readonly arguments_json: string }>(
            database.context.db,
            sql`SELECT arguments_json FROM durable_function_calls
                WHERE "function" = 'cloud.mutate-keys'`,
        );
        expect(calls).toHaveLength(1);
        expect(calls[0]?.arguments_json).not.toContain(cloudKeyInput.authHash);
        expect(calls[0]?.arguments_json).not.toContain(cloudKeyInput.encryptionKey);
        expect(calls[0]?.arguments_json).not.toContain(cloudKeyInput.generatedSecret);

        await module.stop();
        durableFunctions.stop();
        await expect(creating).resolves.toBeInstanceOf(Error);
        saveVault.mockResolvedValue(undefined);

        const restartedDurableFunctions = new DurableFunctionsModule();
        const restarted = new CloudModule(restartedDurableFunctions, profile);
        modules.push({
            cloud: restarted,
            durableFunctions: restartedDurableFunctions,
            profile,
        });
        await resolveModuleHooks(database.context, restarted);
        const durableHooks = await resolveModuleHooks(database.context, restartedDurableFunctions);
        await durableHooks.afterStart?.(database.context, {} as never);
        await waitForCloud(restarted, database, { keys: { status: "create_required" } });
        await vi.waitFor(async () => expect(await pendingDurableCallCount(database)).toBe(0));

        await expect(restarted.createKeys(database.context, cloudKeyInput)).resolves.toMatchObject({
            keys: { status: "ready" },
        });
    });

    it("supersedes process-local key factors with a new durable generation", async () => {
        existingCloudProfile();
        const { database, module } = await fixture("cloud-module-key-factor-replacement");
        await connect(module, database);
        await waitForCloud(module, database, { keys: { status: "create_required" } });
        const replacement = {
            authHash: Buffer.alloc(32, 3).toString("base64url"),
            encryptionKey: cloudKeyInput.encryptionKey,
        };
        const saveVault = vi
            .spyOn(CloudWorkOS.prototype, "saveVault")
            .mockRejectedValueOnce(new Error("network unavailable"))
            .mockResolvedValue(undefined);
        vi.useFakeTimers();

        const first = module
            .createKeys(database.context, cloudKeyInput)
            .catch((error: unknown) => error);
        await vi.waitFor(() => expect(saveVault).toHaveBeenCalledTimes(1));
        const second = module.createKeys(database.context, replacement);

        await expect(first).resolves.toMatchObject({ code: "conflict", status: 409 });
        await vi.waitFor(async () => {
            const calls = await pendingDurableCalls(database, "cloud.mutate-keys");
            expect(calls).toHaveLength(2);
            expect(calls.every((call) => call.operation_id === null)).toBe(true);
            expect(calls.every((call) => call.lock_keys_json === "[]")).toBe(true);
        });
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(second).resolves.toMatchObject({ keys: { status: "ready" } });
        expect(saveVault).toHaveBeenLastCalledWith(
            expect.any(String),
            replacement.authHash,
            expect.any(String),
            expect.any(String),
        );
    });

    it("does not let an in-flight durable enrollment restore a disconnected account", async () => {
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

        const updating = module.enrollProfile(database.context, { username: "ada" });
        await expect(updating).resolves.toEqual({
            enrollment: { status: "enrolling", username: "ada" },
            profile: { firstName: "Ada", username: "ada" },
        });
        await vi.waitFor(() => expect(profileStarted).toBe(true));
        const disconnecting = module.disconnect(database.context);
        releaseProfile();

        await expect(disconnecting).resolves.toMatchObject({ status: "disconnected" });
        expect(module.status(database.context).status).toBe("disconnected");
    });

    it("keeps durable enrollment pending across an upstream profile rejection", async () => {
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

        await expect(module.enrollProfile(database.context, { username: "ada" })).resolves.toEqual({
            enrollment: { status: "enrolling", username: "ada" },
            profile: { firstName: "Ada", username: "ada" },
        });
        await vi.waitFor(() => expect(workos.refresh).toHaveBeenCalled());
        expect((await createCloudDatabase().read(database.context))?.session?.refreshToken).toMatch(
            /^refresh-[ab]$/,
        );
        expect(module.status(database.context)).toMatchObject({
            enrollment: { status: "enrolling", username: "ada" },
            user,
        });
        expect(updates).toHaveLength(1);
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
        const profile = new ProfileModule();
        profile.open("test-instance");
        const restarted = new CloudModule(restartedDurableFunctions, profile);
        modules.push({ cloud: restarted, durableFunctions: restartedDurableFunctions, profile });
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
