import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelCatalog } from "../../protocol/index.js";
import type { InMemorySession } from "../../session/InMemorySession.js";
import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import { createHappySpawnSessionId } from "../createHappySpawnSessionId.js";
import { decryptHappyPayload, encryptHappyPayload } from "../happyEncryption.js";
import { HappySyncService } from "../HappySyncService.js";
import type { HappyConnectionConfiguration } from "../types.js";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("HappySyncService machine spawning", () => {
    it("creates, synchronizes, and idempotently retries a persistent session through encrypted RPC", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-service-"));
        directories.push(directory);
        const databasePath = join(directory, "sessions.sqlite");
        const workspace = join(directory, "workspace");
        await mkdir(workspace);
        const secret = new Uint8Array(32).fill(7);
        const modelCatalog = catalog();
        const configuration: HappyConnectionConfiguration = {
            credentials: {
                encryption: { secret, type: "legacy" },
                token: "happy-token",
            },
            credentialsPath: join(directory, "access.key"),
            happyHome: join(directory, "happy"),
            imported: false,
            machineId: "rig-machine-1",
            serverUrl: "https://happy.example",
        };
        const store = new PersistentSessionStore({ databasePath, modelCatalog });
        const sockets = new Map<string, FakeSocket>();
        const request = vi.fn<typeof fetch>(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === "/v1/machines") {
                const body = JSON.parse(String(init?.body)) as { metadata: string };
                return Response.json({
                    machine: {
                        daemonStateVersion: 0,
                        metadata: body.metadata,
                        metadataVersion: 0,
                    },
                });
            }
            if (url.pathname === "/v1/sessions") {
                const body = JSON.parse(String(init?.body)) as { metadata: string };
                return Response.json({
                    session: {
                        id: "happy-session-1",
                        metadata: body.metadata,
                        metadataVersion: 0,
                    },
                });
            }
            if (url.pathname === "/v3/sessions/happy-session-1/messages") {
                return Response.json(
                    init?.method === "POST" ? {} : { hasMore: false, messages: [] },
                );
            }
            return new Response("Not found", { status: 404 });
        });
        const service = new HappySyncService({
            configuration,
            createSession: (id, sessionRequest) => store.createWithId(id, sessionRequest),
            databasePath,
            fetch: request,
            modelCatalog,
            socketFactory: (_url, options) => {
                const auth = options?.auth as { clientType?: unknown } | undefined;
                const clientType = String(auth?.clientType);
                const socket = new FakeSocket();
                sockets.set(clientType, socket);
                return socket;
            },
        });
        service.start();
        await waitFor(() => sockets.get("machine-scoped")?.connected === true);
        const machine = sockets.get("machine-scoped")!;
        const params = {
            agent: "rig",
            clientRequestId: "mobile-request-1",
            directory: workspace,
            type: "spawn-in-directory",
        };
        const encryptedParams = Buffer.from(encryptHappyPayload(secret, "legacy", params)).toString(
            "base64",
        );

        const first = await machine.requestRpc({
            method: "rig-machine-1:spawn-happy-session",
            params: encryptedParams,
        });
        const second = await machine.requestRpc({
            method: "rig-machine-1:spawn-happy-session",
            params: encryptedParams,
        });

        expect(decode(secret, first)).toEqual({ sessionId: "happy-session-1", type: "success" });
        expect(decode(secret, second)).toEqual({ sessionId: "happy-session-1", type: "success" });
        const localSessionId = createHappySpawnSessionId("rig-machine-1", "mobile-request-1");
        expect(store.get(localSessionId)?.snapshot()).toMatchObject({
            cwd: workspace,
            permissionMode: "auto",
        });
        expect(store.list()).toHaveLength(1);

        await service.close();
        const requestsAfterClose = request.mock.calls.length;
        service.attach(store.create({ cwd: workspace }));
        service.start();
        await Promise.resolve();
        expect(request).toHaveBeenCalledTimes(requestsAfterClose);
        store.close();
    });

    it("keeps session synchronization available when machine metadata cannot be built", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-service-isolation-"));
        directories.push(directory);
        const databasePath = join(directory, "sessions.sqlite");
        const validCatalog = catalog();
        const store = new PersistentSessionStore({ databasePath, modelCatalog: validCatalog });
        const request = vi.fn<typeof fetch>(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === "/v1/sessions") {
                const body = JSON.parse(String(init?.body)) as { metadata: string };
                return Response.json({
                    session: {
                        id: "happy-session-isolated",
                        metadata: body.metadata,
                        metadataVersion: 0,
                    },
                });
            }
            if (url.pathname === "/v3/sessions/happy-session-isolated/messages") {
                return Response.json(
                    init?.method === "POST" ? {} : { hasMore: false, messages: [] },
                );
            }
            return new Response("Not found", { status: 404 });
        });
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const service = new HappySyncService({
            configuration: {
                credentials: {
                    encryption: { secret: new Uint8Array(32).fill(3), type: "legacy" },
                    token: "happy-token",
                },
                credentialsPath: join(directory, "access.key"),
                happyHome: join(directory, "happy"),
                imported: false,
                machineId: "rig-machine-invalid-catalog",
                serverUrl: "https://happy.example",
            },
            createSession: (id, sessionRequest) => store.createWithId(id, sessionRequest),
            databasePath,
            fetch: request,
            modelCatalog: { ...validCatalog, defaultModelId: "missing-model" },
            socketFactory: () => new FakeSocket(),
        });
        try {
            service.attach(store.create({ cwd: directory }));
            await waitFor(() =>
                request.mock.calls.some(([input]) => String(input).endsWith("/v1/sessions")),
            );
            expect(log).toHaveBeenCalledWith(
                expect.stringContaining("machine sync is unavailable"),
            );
        } finally {
            await service.close();
            store.close();
            log.mockRestore();
        }
    });
});

describe("HappySyncService daemon restart", () => {
    it("reconnects sessions already mapped to the active Happy credentials", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-service-restart-"));
        directories.push(directory);
        const databasePath = join(directory, "sessions.sqlite");
        const configuration: HappyConnectionConfiguration = {
            credentials: {
                encryption: { secret: new Uint8Array(32).fill(4), type: "legacy" },
                token: "happy-token",
            },
            credentialsPath: join(directory, "access.key"),
            happyHome: join(directory, "happy"),
            imported: false,
            serverUrl: "https://happy.example",
        };
        const sockets: FakeSocket[] = [];
        const request = vi.fn<typeof fetch>(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === "/v1/sessions") {
                const body = JSON.parse(String(init?.body)) as { metadata: string };
                return Response.json({
                    session: {
                        active: true,
                        id: "happy-session-restarted",
                        metadata: body.metadata,
                        metadataVersion: 0,
                    },
                });
            }
            if (url.pathname === "/v3/sessions/happy-session-restarted/messages") {
                return Response.json(
                    init?.method === "POST" ? {} : { hasMore: false, messages: [] },
                );
            }
            return new Response("Not found", { status: 404 });
        });
        const createService = (store: PersistentSessionStore) =>
            new HappySyncService({
                configuration,
                databasePath,
                fetch: request,
                loadSession: (sessionId) => store.get(sessionId),
                socketFactory: () => {
                    const socket = new FakeSocket();
                    sockets.push(socket);
                    return socket;
                },
            });
        const firstStore = new PersistentSessionStore({ databasePath, modelCatalog: catalog() });
        const session = firstStore.create({ cwd: directory });
        const firstService = createService(firstStore);
        let restartedService: HappySyncService | undefined;
        let restartedStore: PersistentSessionStore | undefined;

        try {
            firstService.attach(session);
            await waitFor(() => sockets[0]?.connected === true);
            await firstService.close();
            firstStore.close();

            restartedStore = new PersistentSessionStore({ databasePath, modelCatalog: catalog() });
            restartedService = createService(restartedStore);
            restartedService.start();

            await waitFor(() => sockets[1]?.connected === true);
            expect(sockets[1]?.emitted).toContainEqual([
                "rpc-register",
                { method: "happy-session-restarted:killSession" },
            ]);
        } finally {
            await restartedService?.close();
            restartedStore?.close();
            await firstService.close();
            firstStore.close();
        }
    });

    it("restores live sessions without loading the ones it would never reattach", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-service-restore-scope-"));
        directories.push(directory);
        const databasePath = join(directory, "sessions.sqlite");
        const configuration: HappyConnectionConfiguration = {
            credentials: {
                encryption: { secret: new Uint8Array(32).fill(6), type: "legacy" },
                token: "happy-token",
            },
            credentialsPath: join(directory, "access.key"),
            happyHome: join(directory, "happy"),
            imported: false,
            serverUrl: "https://happy.example",
        };
        const sockets: FakeSocket[] = [];
        let remoteSessionCount = 0;
        const request = vi.fn<typeof fetch>(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === "/v1/sessions") {
                remoteSessionCount += 1;
                const body = JSON.parse(String(init?.body)) as { metadata: string };
                return Response.json({
                    session: {
                        active: true,
                        id: `happy-session-scope-${String(remoteSessionCount)}`,
                        metadata: body.metadata,
                        metadataVersion: 0,
                    },
                });
            }
            if (url.pathname.endsWith("/messages")) {
                return Response.json(
                    init?.method === "POST" ? {} : { hasMore: false, messages: [] },
                );
            }
            if (url.pathname.endsWith("/archive")) return Response.json({ success: true });
            return new Response("Not found", { status: 404 });
        });
        const createService = (loadSession?: (sessionId: string) => InMemorySession | undefined) =>
            new HappySyncService({
                configuration,
                databasePath,
                fetch: request,
                ...(loadSession === undefined ? {} : { loadSession }),
                socketFactory: () => {
                    const socket = new FakeSocket();
                    sockets.push(socket);
                    return socket;
                },
            });
        const firstStore = new PersistentSessionStore({ databasePath, modelCatalog: catalog() });
        const archived = firstStore.create({ cwd: directory });
        const live = firstStore.create({ cwd: directory });
        const firstService = createService();
        let restartedService: HappySyncService | undefined;
        let restartedStore: PersistentSessionStore | undefined;

        try {
            firstService.attach(archived);
            firstService.attach(live);
            await waitFor(
                () => sockets.length === 2 && sockets.every((socket) => socket.connected),
            );
            archived.setArchived(true);
            await firstService.close();
            firstStore.close();

            restartedStore = new PersistentSessionStore({ databasePath, modelCatalog: catalog() });
            const store = restartedStore;
            const loadSession = vi.fn((sessionId: string) => store.get(sessionId));
            restartedService = createService(loadSession);
            restartedService.start();

            await waitFor(() => sockets[2]?.connected === true);
            expect(loadSession.mock.calls).toEqual([[live.id]]);
            expect(sockets).toHaveLength(3);
        } finally {
            await restartedService?.close();
            restartedStore?.close();
            await firstService.close();
            firstStore.close();
        }
    });
});

describe("HappySyncService session archival", () => {
    it("ends Happy synchronization and does not reattach an archived Rig session", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-service-archive-"));
        directories.push(directory);
        const databasePath = join(directory, "sessions.sqlite");
        const store = new PersistentSessionStore({ databasePath, modelCatalog: catalog() });
        const sockets: FakeSocket[] = [];
        const secret = new Uint8Array(32).fill(5);
        const configuration: HappyConnectionConfiguration = {
            credentials: {
                encryption: { secret, type: "legacy" },
                token: "happy-token",
            },
            credentialsPath: join(directory, "access.key"),
            happyHome: join(directory, "happy"),
            imported: false,
            serverUrl: "https://happy.example",
        };
        let archiveResponseCount = 0;
        let resolveFirstArchive: ((response: Response) => void) | undefined;
        const firstArchive = new Promise<Response>((resolve) => {
            resolveFirstArchive = resolve;
        });
        const request = vi.fn<typeof fetch>(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === "/v1/sessions") {
                const body = JSON.parse(String(init?.body)) as { metadata: string };
                return Response.json({
                    session: {
                        id: "happy-session-archive",
                        metadata: body.metadata,
                        metadataVersion: 0,
                    },
                });
            }
            if (url.pathname === "/v3/sessions/happy-session-archive/messages") {
                return Response.json(
                    init?.method === "POST" ? {} : { hasMore: false, messages: [] },
                );
            }
            if (url.pathname === "/v1/sessions/happy-session-archive/archive") {
                archiveResponseCount += 1;
                if (archiveResponseCount === 1) return firstArchive;
                return Response.json({ success: true });
            }
            return new Response("Not found", { status: 404 });
        });
        const createService = () =>
            new HappySyncService({
                configuration,
                databasePath,
                fetch: request,
                modelCatalog: catalog(),
                socketFactory: () => {
                    const socket = new FakeSocket();
                    sockets.push(socket);
                    return socket;
                },
            });
        const service = createService();
        let restartedService: HappySyncService | undefined;
        const session = store.create({ cwd: directory });

        try {
            service.attach(session);
            await waitFor(
                () => sockets[0]?.emitted.some(([event]) => event === "session-alive") === true,
            );

            session.setArchived(true);
            const archivedEvent = session.events.since(undefined)?.at(-1);
            if (archivedEvent === undefined) throw new Error("The archive event was not recorded.");
            service.observe(archivedEvent, session);

            await waitFor(
                () => sockets[0]?.emitted.some(([event]) => event === "session-end") === true,
            );
            await waitFor(() => archiveRequestCount(request) === 1);
            expect(
                sockets[0]?.emitted.find(([event]) => event === "session-end")?.[1],
            ).toMatchObject({
                sid: "happy-session-archive",
            });
            const archivedMetadata = decryptMetadata(
                secret,
                sockets[0]?.emitted.filter(([event]) => event === "update-metadata").at(-1)?.[1]
                    .metadata,
            );
            expect(archivedMetadata).toMatchObject({
                archiveReason: "Session archived in Rig",
                archivedBy: "rig",
                lifecycleState: "archived",
            });

            service.attach(session);
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(sockets).toHaveLength(1);

            session.setArchived(false);
            const restoredEvent = session.events.since(undefined)?.at(-1);
            if (restoredEvent === undefined) throw new Error("The restore event was not recorded.");
            service.observe(restoredEvent, session);
            service.attach(session);

            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(sockets).toHaveLength(1);
            resolveFirstArchive?.(Response.json({ success: true }));

            await waitFor(
                () =>
                    decryptMetadata(
                        secret,
                        sockets[1]?.emitted
                            .filter(([event]) => event === "update-metadata")
                            .at(-1)?.[1].metadata,
                    )?.lifecycleState === "running",
            );
            const restoredMetadata = decryptMetadata(
                secret,
                sockets[1]?.emitted.filter(([event]) => event === "update-metadata").at(-1)?.[1]
                    .metadata,
            );
            expect(restoredMetadata).not.toHaveProperty("archiveReason");
            expect(restoredMetadata).not.toHaveProperty("archivedBy");
            expect(sockets[0]?.connected).toBe(false);

            await service.close();
            restartedService = createService();
            session.setArchived(true);
            const restartedArchiveEvent = session.events.since(undefined)?.at(-1);
            if (restartedArchiveEvent === undefined) {
                throw new Error("The restarted archive event was not recorded.");
            }
            restartedService.observe(restartedArchiveEvent, session);

            await waitFor(() => archiveRequestCount(request) === 2);
            expect(
                sockets[2]?.emitted.find(([event]) => event === "session-end")?.[1],
            ).toMatchObject({
                sid: "happy-session-archive",
            });
        } finally {
            await restartedService?.close();
            await service.close();
            store.close();
        }
    });
});

/*
 * The fake keeps socket events observable because archival has two independent
 * remote effects: encrypted lifecycle metadata and the immediate session-end signal.
 */
class FakeSocket {
    connected = false;
    readonly emitted: Array<[string, any]> = [];
    readonly #listeners = new Map<string, (...values: any[]) => void>();

    connect(): void {
        this.connected = true;
        this.#listeners.get("connect")?.();
    }

    disconnect(): void {
        this.connected = false;
    }

    emit(event: string, ...values: any[]): void {
        this.emitted.push([event, values[0]]);
        const callback = values.at(-1);
        if (typeof callback !== "function") return;
        if (event === "machine-update-metadata") {
            callback({ metadata: values[0].metadata, result: "success", version: 1 });
        } else if (event === "machine-update-state") {
            callback({ daemonState: values[0].daemonState, result: "success", version: 1 });
        } else if (event === "update-metadata") {
            callback({ result: "success", version: 1 });
        }
    }

    on(event: string, listener: (...values: any[]) => void): void {
        this.#listeners.set(event, listener);
    }

    requestRpc(request: unknown): Promise<string> {
        return new Promise((resolve) => this.#listeners.get("rpc-request")?.(request, resolve));
    }
}

function catalog(): ModelCatalog {
    const model = {
        defaultThinkingLevel: "high",
        id: "gpt-test",
        name: "GPT Test",
        thinkingLevels: ["low", "high"],
    } as const;
    return {
        defaultModelId: model.id,
        defaultProviderId: "codex",
        models: [model],
        providers: [{ models: [model], providerId: "codex" }],
    };
}

function decode(secret: Uint8Array, value: string): unknown {
    return decryptHappyPayload(secret, "legacy", Buffer.from(value, "base64"));
}

function archiveRequestCount(request: ReturnType<typeof vi.fn<typeof fetch>>): number {
    return request.mock.calls.filter(
        ([input]) =>
            new URL(String(input)).pathname === "/v1/sessions/happy-session-archive/archive",
    ).length;
}

function decryptMetadata(secret: Uint8Array, value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== "string") return undefined;
    const decoded = decode(secret, value);
    return typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
        ? (decoded as Record<string, unknown>)
        : undefined;
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for Happy synchronization.");
}
