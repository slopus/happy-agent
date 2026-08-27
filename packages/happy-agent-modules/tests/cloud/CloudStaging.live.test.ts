import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
    destroyIdentity,
    HttpRelaySessionProvider,
    importIdentityKeyPair,
    MemoryMurmurStore,
    MurmurClient,
    type IdentityKeyPair,
} from "@slopus/murmur";
import { ensureAgentDatabaseConnection } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { withLogger, type LogContext, type Logger } from "@steve.kite/stdlib";
import { WorkOS } from "@workos-inc/node";
import { describe, expect, test, vi } from "vitest";

import { CloudModule } from "../../sources/cloud/CloudModule.js";
import { cloudSession, createCloudDatabase } from "../../sources/cloud/CloudDatabase.js";
import { createCloudDisconnectDatabase } from "../../sources/cloud/CloudDisconnectDatabase.js";
import {
    createCloudKeysDatabase,
    type ReadyCloudKeys,
} from "../../sources/cloud/CloudKeysDatabase.js";
import { createCloudKeyTree, type CloudKeyTree } from "../../sources/cloud/CloudKeyTree.js";
import { CloudMurmurStore } from "../../sources/cloud/CloudMurmurStore.js";
import { CloudWorkOS } from "../../sources/cloud/CloudWorkOS.js";
import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { ProfileModule } from "../../sources/profile/index.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const WORKOS_CLIENT_ID = "client_01KZD3XE4EW1AF1P6WTFHBPR4J";
const MURMUR_SESSION_ISSUER = "https://murmur-relay-staging.bulka-llc.workers.dev/v2/session";
const MURMUR_DIRECTORY_ISSUER =
    "https://murmur-relay-staging.bulka-llc.workers.dev/v2/directory-ticket";
const REQUEST_TIMEOUT_MILLISECONDS = 20_000;
const LIVE_TEST_TIMEOUT_MILLISECONDS = 180_000;
const DEFAULT_CREDENTIALS_FILE = fileURLToPath(
    new URL("../../../../.context/workos-staging.json", import.meta.url),
);
const CREDENTIALS_PATH_VARIABLE = "HAPPY_AGENT_WORKOS_STAGING_CREDENTIALS_FILE";
const generatedSecret = "H1-222A5-AS7TZ-QRFS4-BJ48X-Q4S7SN";

const stagingCredentialsSchema = Type.Object(
    { workosApiKey: Type.String({ minLength: 1, maxLength: 4_096 }) },
    { additionalProperties: false },
);
type StagingCredentials = Static<typeof stagingCredentialsSchema>;

interface StagingUser {
    readonly email: string;
    readonly id: string;
    readonly password: string;
}

interface StagingAuthentication {
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly user: {
        readonly email: string;
        readonly firstName: string | null;
        readonly id: string;
        readonly lastName: string | null;
    };
}

interface LiveCloudInstance {
    readonly cloud: CloudModule;
    readonly database: ModuleDatabase;
    readonly logs: readonly string[];
    stop(): Promise<void>;
}

function stagingCredentials(): StagingCredentials | undefined {
    const explicitPath = process.env[CREDENTIALS_PATH_VARIABLE];
    const path = explicitPath ?? DEFAULT_CREDENTIALS_FILE;
    if (!existsSync(path)) {
        if (explicitPath !== undefined) {
            throw new Error(`${CREDENTIALS_PATH_VARIABLE} does not name a readable file.`);
        }
        return undefined;
    }
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
        throw new Error("The WorkOS staging credential file is not valid JSON.");
    }
    if (!Value.Check(stagingCredentialsSchema, value)) {
        throw new Error("The WorkOS staging credential file must contain only workosApiKey.");
    }
    return structuredClone(value) as StagingCredentials;
}

const credentials = stagingCredentials();

function keyFactor(): string {
    return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

function deviceKey(value: Uint8Array): string {
    return Buffer.from(value).toString("base64url");
}

function authenticatedFetch(accessToken: string): typeof fetch {
    return async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${accessToken}`);
        return await fetch(input, { ...init, headers });
    };
}

function derivedIdentity(keys: ReadyCloudKeys): {
    readonly identity: IdentityKeyPair;
    readonly keyTree: CloudKeyTree;
} {
    const root = new Uint8Array(Buffer.from(keys.rootSecret, "base64url"));
    let keyTree: CloudKeyTree | undefined;
    let derived: ReturnType<CloudKeyTree["deriveEd25519Key"]> | undefined;
    try {
        if (root.byteLength !== 32 || Buffer.from(root).toString("base64url") !== keys.rootSecret) {
            throw new Error("The live test received an invalid Cloud root.");
        }
        keyTree = createCloudKeyTree(root);
        derived = keyTree.deriveEd25519Key(["murmur", "identity"]);
        const identity = importIdentityKeyPair(derived.secret);
        if (Buffer.from(identity.publicKey).toString("base64url") !== keys.identityKey) {
            destroyIdentity(identity);
            throw new Error("The live test derived the wrong Cloud identity.");
        }
        return { identity, keyTree };
    } catch (error: unknown) {
        keyTree?.destroy();
        throw error;
    } finally {
        root.fill(0);
        derived?.secret.fill(0);
        derived?.public.fill(0);
    }
}

async function openSibling(keys: ReadyCloudKeys, accessToken: string): Promise<MurmurClient> {
    const derived = derivedIdentity(keys);
    try {
        return await MurmurClient.open({
            identity: derived.identity,
            sessionProvider: new HttpRelaySessionProvider(MURMUR_SESSION_ISSUER, {
                fetch: authenticatedFetch(accessToken),
                requestTimeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS,
            }),
            store: new MemoryMurmurStore(),
            webSocket: {
                requestTimeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS,
                streamHeartbeatTimeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS,
            },
        });
    } finally {
        destroyIdentity(derived.identity);
        derived.keyTree.destroy();
    }
}

async function openCloudInstance(
    name: string,
    authentication: StagingAuthentication,
    enrollment: "existing" | "new",
): Promise<LiveCloudInstance> {
    const durableFunctions = new DurableFunctionsModule();
    const profile = new ProfileModule();
    profile.open(`staging-${crypto.randomUUID()}`);
    const cloud = new CloudModule(durableFunctions, profile);
    const database = moduleDatabase(
        [...cloud.migrations, ...profile.migrations, ...durableFunctions.migrations],
        name,
    );
    ensureAgentDatabaseConnection(database.database);
    await database.ready;
    const logs: string[] = [];
    const ctx = withLogger(database.context, recordingLogger(logs));
    const localProfile = await profile.ensure(ctx);
    const updatedProfile = await profile.update(ctx, localProfile.id, {
        email: authentication.user.email,
        name: authentication.user.firstName ?? "Staging Cloud user",
    });
    if (updatedProfile === undefined) throw new Error("The live Cloud profile was not created.");
    await createCloudDatabase().replace(ctx, {
        error: null,
        pending: false,
        session: cloudSession(
            "staging",
            authentication.refreshToken,
            authentication.user,
            undefined,
            enrollment === "new" ? { status: "required" } : { status: "checking" },
        ),
    });

    const durableHooks = await resolveModuleHooks(ctx, durableFunctions);
    const cloudHooks = await resolveModuleHooks(ctx, cloud);
    await durableHooks.afterStart?.(ctx, {} as never);
    await cloudHooks.afterStart?.(ctx, {} as never);
    if (enrollment === "new") {
        await cloud.enrollProfile(ctx, { username: stagingUsername() });
    }
    await expect
        .poll(
            () => {
                const status = cloud.status(ctx);
                return `${status.enrollment?.status}:${status.keys?.status ?? "none"}`;
            },
            { interval: 250, timeout: 30_000 },
        )
        .toBe(enrollment === "new" ? "enrolled:create_required" : "enrolled:restore_required");
    let stopped = false;
    return {
        cloud,
        database,
        logs,
        stop: async () => {
            if (stopped) return;
            stopped = true;
            await cloud.stop();
            durableFunctions.stop();
            database.close();
        },
    };
}

function stagingUsername(): string {
    return `ha${Date.now().toString(36)}${crypto.randomUUID().replaceAll("-", "").slice(0, 6)}`;
}

function recordingLogger(records: string[]): Logger {
    const write =
        (level: keyof Logger) =>
        (_context: LogContext, ...args: readonly unknown[]) => {
            records.push(`${String(level)} ${args.map(String).join(" ")}`);
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

async function waitForAgentDevice(
    sibling: MurmurClient,
    instance: LiveCloudInstance,
    account: { readonly environment: "staging"; readonly userId: string },
    openErrors: readonly string[],
): Promise<readonly string[]> {
    try {
        return await waitForDevices(sibling, 2);
    } catch (error: unknown) {
        const entries = await new CloudMurmurStore(instance.database.context, account).list("");
        throw new Error(
            `The Happy Agent device did not register; localStoreEntries=${String(entries.size)} openErrors=${openErrors.join(" | ")} logs=${instance.logs.join(" | ")}`,
            { cause: error },
        );
    }
}

function captureMurmurOpens(): {
    readonly errors: string[];
    readonly opened: string[];
    readonly restore: () => void;
} {
    const errors: string[] = [];
    const opened: string[] = [];
    const original = MurmurClient.open.bind(MurmurClient);
    const spy = vi.spyOn(MurmurClient, "open").mockImplementation(async (options) => {
        try {
            const client = await original(options);
            opened.push(deviceKey(client.deviceKey));
            return client;
        } catch (error: unknown) {
            errors.push(error instanceof Error ? `${error.name}: ${error.message}` : "unknown");
            throw error;
        }
    });
    return { errors, opened, restore: () => spy.mockRestore() };
}

async function waitForDaemonMurmurOpen(
    instance: LiveCloudInstance,
    account: { readonly environment: "staging"; readonly userId: string },
    murmurOpen: ReturnType<typeof captureMurmurOpens>,
): Promise<string> {
    try {
        await expect
            .poll(() => murmurOpen.opened.length, { interval: 250, timeout: 30_000 })
            .toBe(1);
        return murmurOpen.opened[0]!;
    } catch (error: unknown) {
        const entries = await new CloudMurmurStore(instance.database.context, account).list("");
        throw new Error(
            `The Happy Agent Murmur client did not open; localStoreEntries=${String(entries.size)} openErrors=${murmurOpen.errors.join(" | ")} logs=${instance.logs.join(" | ")}`,
            { cause: error },
        );
    }
}

async function createStagingUser(workos: WorkOS, label: string): Promise<StagingUser> {
    const suffix = `${Date.now()}-${crypto.randomUUID()}`;
    const email = `ha-${label}-${suffix}@murmur-e2e.test`;
    const password = `Happy-Agent-${crypto.randomUUID()}-Aa1!`;
    const user = await workos.userManagement.createUser({
        email,
        emailVerified: true,
        firstName: "Happy Agent staging",
        password,
    });
    return { email, id: user.id, password };
}

async function authenticate(workos: WorkOS, user: StagingUser): Promise<StagingAuthentication> {
    const authenticated = await workos.userManagement.authenticateWithPassword({
        clientId: WORKOS_CLIENT_ID,
        email: user.email,
        password: user.password,
    });
    return {
        accessToken: authenticated.accessToken,
        refreshToken: authenticated.refreshToken,
        user: {
            email: authenticated.user.email,
            firstName: authenticated.user.firstName ?? null,
            id: authenticated.user.id,
            lastName: authenticated.user.lastName ?? null,
        },
    };
}

async function cleanupStagingUser(workos: WorkOS, user: StagingUser): Promise<void> {
    try {
        const authenticated = await authenticate(workos, user);
        await new CloudWorkOS("staging").deleteVault(authenticated.accessToken);
    } catch {
        // Cleanup is best effort after the assertion result has already been determined.
    }
    await workos.userManagement.deleteUser(user.id).catch(() => undefined);
}

async function waitForDevices(client: MurmurClient, expected: number): Promise<readonly string[]> {
    let latest: readonly string[] = [];
    await expect
        .poll(
            async () => {
                await client.synchronize({ waitMilliseconds: 0 });
                latest = (await client.devices()).map((entry) => deviceKey(entry.deviceKey));
                return latest.length;
            },
            { interval: 250, timeout: 30_000 },
        )
        .toBe(expected);
    return latest;
}

async function directoryTicket(accessToken: string): Promise<Uint8Array> {
    const response = await authenticatedFetch(accessToken)(MURMUR_DIRECTORY_ISSUER, {
        method: "POST",
    });
    if (!response.ok) throw new Error(`Directory ticket request failed (${response.status})`);
    const value = (await response.json()) as unknown;
    const schema = Type.Object(
        {
            version: Type.Literal(1),
            ticket: Type.String({ minLength: 1, maxLength: 65_536 }),
            expiresAt: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false },
    );
    if (!Value.Check(schema, value)) throw new Error("Invalid directory ticket response");
    return new Uint8Array(Buffer.from(value.ticket, "base64url"));
}

async function settleMurmur(clients: readonly MurmurClient[], rounds: number = 12): Promise<void> {
    for (let round = 0; round < rounds; round += 1) {
        for (const client of clients) await client.synchronize({ waitMilliseconds: 0 });
    }
}

async function activatePendingSession(client: MurmurClient, sessionId: Uint8Array): Promise<void> {
    if ((await client.session(sessionId))?.status === "pending") {
        await client.activateSession(sessionId);
    }
}

async function receiveMessage(
    sender: MurmurClient,
    recipients: readonly MurmurClient[],
    expected: string,
): Promise<void> {
    const received = recipients.map(() => new Set<string>());
    for (let round = 0; round < 16; round += 1) {
        await sender.synchronize({ waitMilliseconds: 0 });
        for (const [index, recipient] of recipients.entries()) {
            await recipient.synchronize(
                { waitMilliseconds: 0 },
                {
                    onUpdates: (updates) => {
                        for (const update of updates) {
                            received[index]!.add(new TextDecoder().decode(update.bytes));
                        }
                    },
                },
            );
        }
        if (received.every((messages) => messages.has(expected))) return;
    }
    throw new Error(
        `Murmur message did not reach every device: ${received
            .map((messages, index) => `${String(index)}=${[...messages].join(",")}`)
            .join(" ")}`,
    );
}

describe.runIf(credentials !== undefined)("Happy Agent Cloud staging lifecycle", () => {
    test(
        "disconnects its own device, then resets a vault after all local keys are lost",
        async () => {
            const workos = new WorkOS({
                apiKey: credentials!.workosApiKey,
                clientId: WORKOS_CLIENT_ID,
                maxRetries: 0,
                timeout: REQUEST_TIMEOUT_MILLISECONDS,
            });
            const user = await createStagingUser(workos, "d");
            const instances: LiveCloudInstance[] = [];
            const murmurOpen = captureMurmurOpens();
            let sibling: MurmurClient | undefined;
            try {
                const firstAuthentication = await authenticate(workos, user);
                const first = await openCloudInstance(
                    "cloud-staging-self-disconnect",
                    firstAuthentication,
                    "new",
                );
                instances.push(first);
                const factors = {
                    authHash: keyFactor(),
                    encryptionKey: keyFactor(),
                    generatedSecret,
                };
                await expect(
                    first.cloud.createKeys(first.database.context, factors),
                ).resolves.toMatchObject({ keys: { status: "ready" } });
                const account = { environment: "staging", userId: user.id } as const;
                const keys = await createCloudKeysDatabase().read(first.database.context, account);
                if (keys?.status !== "ready") throw new Error("Cloud keys did not become ready.");
                await expect(first.cloud.getKeyBackup(first.database.context)).resolves.toEqual({
                    generatedSecret,
                    rootSecret: keys.rootSecret,
                });
                const daemonDevice = await waitForDaemonMurmurOpen(first, account, murmurOpen);

                sibling = await openSibling(keys, firstAuthentication.accessToken);
                const beforeDisconnect = await waitForAgentDevice(
                    sibling,
                    first,
                    account,
                    murmurOpen.errors,
                );
                const siblingKey = deviceKey(sibling.deviceKey);
                const disconnectedDevice = beforeDisconnect.find((key) => key !== siblingKey);
                if (disconnectedDevice === undefined) {
                    throw new Error("The Happy Agent Murmur device was not registered.");
                }
                expect(disconnectedDevice).toBe(daemonDevice);

                await expect(first.cloud.disconnect(first.database.context)).resolves.toMatchObject(
                    {
                        status: "disconnected",
                    },
                );
                await expect
                    .poll(
                        async () =>
                            await createCloudDisconnectDatabase().read(first.database.context),
                        { interval: 250, timeout: 30_000 },
                    )
                    .toBeUndefined();
                await expect(
                    createCloudKeysDatabase().read(first.database.context, account),
                ).resolves.toBeUndefined();
                await expect(
                    new CloudMurmurStore(first.database.context, account).list(""),
                ).resolves.toEqual(new Map());
                let afterDisconnect: readonly string[];
                try {
                    afterDisconnect = await waitForDevices(sibling, 1);
                } catch (error: unknown) {
                    throw new Error(
                        `Happy Agent locally disconnected without removing its Murmur device; openErrors=${murmurOpen.errors.join(" | ")} logs=${first.logs.join(" | ")}`,
                        { cause: error },
                    );
                }
                expect(afterDisconnect).toEqual([siblingKey]);
                expect(afterDisconnect).not.toContain(disconnectedDevice);

                const lostAuthentication = await authenticate(workos, user);
                const lost = await openCloudInstance(
                    "cloud-staging-lost-keys",
                    lostAuthentication,
                    "existing",
                );
                instances.push(lost);
                await expect(
                    lost.cloud.deleteKeys(lost.database.context, {
                        confirmation: "YES DELETE MY VAULT",
                    }),
                ).resolves.toMatchObject({ keys: { status: "create_required" } });
                const minted = await lost.cloud.mint(lost.database.context);
                await expect(
                    new CloudWorkOS("staging").getVaultIdentity(minted.accessToken),
                ).resolves.toBeUndefined();
                await lost.cloud.disconnect(lost.database.context);
                await expect
                    .poll(
                        async () =>
                            await createCloudDisconnectDatabase().read(lost.database.context),
                        { interval: 250, timeout: 30_000 },
                    )
                    .toBeUndefined();
            } finally {
                for (const instance of instances.reverse()) await instance.stop();
                await sibling?.deleteAccount().catch(() => undefined);
                sibling?.close();
                murmurOpen.restore();
                await cleanupStagingUser(workos, user);
            }
        },
        LIVE_TEST_TIMEOUT_MILLISECONDS,
    );

    test(
        "keeps a device registered after local instance erasure until a sibling removes it",
        async () => {
            const workos = new WorkOS({
                apiKey: credentials!.workosApiKey,
                clientId: WORKOS_CLIENT_ID,
                maxRetries: 0,
                timeout: REQUEST_TIMEOUT_MILLISECONDS,
            });
            const user = await createStagingUser(workos, "o");
            const murmurOpen = captureMurmurOpens();
            let instance: LiveCloudInstance | undefined;
            let sibling: MurmurClient | undefined;
            try {
                const authentication = await authenticate(workos, user);
                instance = await openCloudInstance(
                    "cloud-staging-instance-erasure",
                    authentication,
                    "new",
                );
                await instance.cloud.createKeys(instance.database.context, {
                    authHash: keyFactor(),
                    encryptionKey: keyFactor(),
                    generatedSecret,
                });
                const account = { environment: "staging", userId: user.id } as const;
                const keys = await createCloudKeysDatabase().read(
                    instance.database.context,
                    account,
                );
                if (keys?.status !== "ready") throw new Error("Cloud keys did not become ready.");
                const daemonDevice = await waitForDaemonMurmurOpen(instance, account, murmurOpen);
                sibling = await openSibling(keys, authentication.accessToken);
                const roster = await waitForAgentDevice(
                    sibling,
                    instance,
                    account,
                    murmurOpen.errors,
                );
                const siblingKey = deviceKey(sibling.deviceKey);
                const orphanedDevice = roster.find((key) => key !== siblingKey);
                if (orphanedDevice === undefined) throw new Error("The device was not registered.");
                expect(orphanedDevice).toBe(daemonDevice);

                await instance.stop();
                instance = undefined;

                expect(await waitForDevices(sibling, 2)).toContain(orphanedDevice);
                await sibling.removeDevice(Buffer.from(orphanedDevice, "base64url"));
                expect(await waitForDevices(sibling, 1)).toEqual([siblingKey]);
            } finally {
                await instance?.stop();
                await sibling?.deleteAccount().catch(() => undefined);
                sibling?.close();
                murmurOpen.restore();
                await cleanupStagingUser(workos, user);
            }
        },
        LIVE_TEST_TIMEOUT_MILLISECONDS,
    );

    test("forms a group across two users with two restored devices each and exchanges messages", async () => {
        const workos = new WorkOS({
            apiKey: credentials!.workosApiKey,
            clientId: WORKOS_CLIENT_ID,
            maxRetries: 0,
            timeout: REQUEST_TIMEOUT_MILLISECONDS,
        });
        const users = [
            await createStagingUser(workos, "ga"),
            await createStagingUser(workos, "gb"),
        ] as const;
        const instances: LiveCloudInstance[] = [];
        const clients: MurmurClient[] = [];
        const murmurOpen = captureMurmurOpens();
        try {
            const authentications = [
                await authenticate(workos, users[0]),
                await authenticate(workos, users[1]),
            ] as const;
            const accountClients: [MurmurClient, MurmurClient][] = [];

            for (const [index, user] of users.entries()) {
                const authentication = authentications[index]!;
                const instance = await openCloudInstance(
                    `cloud-staging-group-user-${String(index)}`,
                    authentication,
                    "new",
                );
                instances.push(instance);
                const priorOpens = murmurOpen.opened.length;
                await instance.cloud.createKeys(instance.database.context, {
                    authHash: keyFactor(),
                    encryptionKey: keyFactor(),
                    generatedSecret,
                });
                await expect
                    .poll(() => murmurOpen.opened.length, {
                        interval: 250,
                        timeout: 30_000,
                    })
                    .toBe(priorOpens + 1);
                const daemonDevice = murmurOpen.opened[priorOpens]!;
                const account = { environment: "staging", userId: user.id } as const;
                const keys = await createCloudKeysDatabase().read(
                    instance.database.context,
                    account,
                );
                if (keys?.status !== "ready") {
                    throw new Error("Cloud keys did not become ready for the group test.");
                }
                const first = await openSibling(keys, authentication.accessToken);
                const second = await openSibling(keys, authentication.accessToken);
                clients.push(first, second);
                expect(await waitForDevices(first, 3)).toContain(daemonDevice);
                await first.removeDevice(Buffer.from(daemonDevice, "base64url"));
                expect(new Set(await waitForDevices(first, 2))).toEqual(
                    new Set([deviceKey(first.deviceKey), deviceKey(second.deviceKey)]),
                );
                await instance.stop();
                accountClients.push([first, second]);
            }

            const aliceDevices = accountClients[0];
            const bobDevices = accountClients[1];
            if (aliceDevices === undefined || bobDevices === undefined) {
                throw new Error("The two staging accounts did not open all Murmur devices.");
            }
            const allClients = [...aliceDevices, ...bobDevices];
            await settleMurmur(allClients);
            const claim = await aliceDevices[0].claimAccount(
                bobDevices[0].accountKey,
                await directoryTicket(authentications[0].accessToken),
            );
            expect(claim.members).toHaveLength(2);
            const aliceSecondDevice = await aliceDevices[1].createKeyPackage();
            const group = await aliceDevices[0].createSession({
                descriptor: new TextEncoder().encode("happy-agent-staging-multidevice-group"),
                members: [aliceSecondDevice, claim],
                sendPolicy: "everyone",
            });
            await settleMurmur(allClients, 20);
            for (const client of allClients.slice(1)) {
                await activatePendingSession(client, group.id);
            }
            await settleMurmur(allClients, 8);
            for (const client of allClients) {
                expect((await client.session(group.id))?.status).toBe("active");
            }

            const aliceMessage = "hello from Alice device one";
            await aliceDevices[0].send(group.id, new TextEncoder().encode(aliceMessage));
            await receiveMessage(aliceDevices[0], [aliceDevices[1], ...bobDevices], aliceMessage);

            const bobMessage = "hello from Bob device two";
            await bobDevices[1].send(group.id, new TextEncoder().encode(bobMessage));
            await receiveMessage(bobDevices[1], [...aliceDevices, bobDevices[0]], bobMessage);

            await aliceDevices[0].deleteSession(group.id);
            await settleMurmur(allClients);
            await aliceDevices[0].deleteAccount();
            await bobDevices[0].deleteAccount();
        } finally {
            for (const instance of instances.reverse()) await instance.stop();
            for (const client of clients.reverse()) client.close();
            murmurOpen.restore();
            for (const user of [...users].reverse()) await cleanupStagingUser(workos, user);
        }
    }, 300_000);
});
