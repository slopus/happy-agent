import { io, type Socket } from "socket.io-client";

import { Value } from "@sinclair/typebox/value";

import type { ModelCatalog } from "../protocol/index.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import { readPackageVersion } from "../readPackageVersion.js";
import { createHappyMachineMetadata } from "./createHappyMachineMetadata.js";
import { decryptHappyPayload, encryptHappyPayload, wrapHappyDataKey } from "./happyEncryption.js";
import type {
    HappyConnectionConfiguration,
    HappyListWorkspacesResult,
    HappySpawnSessionRequest,
    HappySpawnSessionResult,
} from "./types.js";
import { happySpawnSessionRequestSchema } from "./types.js";

const HTTP_TIMEOUT_MS = 15_000;
const RETRY_INTERVAL_MS = 5_000;
const MAX_REMEMBERED_SPAWN_REQUESTS = 1_000;
const KEEP_ALIVE_INTERVAL_MS = 20_000;

interface HappyMachineSocket {
    connect(): void;
    disconnect(): void;
    emit(event: string, ...values: any[]): void;
    on(event: string, listener: (...arguments_: any[]) => void): void;
}

export interface HappyMachineClientOptions {
    configuration: HappyConnectionConfiguration;
    fetch?: typeof fetch;
    modelCatalog: ModelCatalog;
    socketFactory?: (url: string, options: Parameters<typeof io>[1]) => HappyMachineSocket;
    spawnSession: (params: unknown, signal: AbortSignal) => Promise<HappySpawnSessionResult>;
    /**
     * Lists the managed workspaces of the project at a directory. Registered as
     * its own machine RPC only when supplied — Happy discovers worktrees on a
     * CLI machine by running git over the `bash` RPC, which Rig does not expose.
     */
    listWorkspaces?: (params: unknown) => Promise<HappyListWorkspacesResult>;
    supportsWorktrees?: boolean;
}

export class HappyMachineClient {
    readonly #configuration: HappyConnectionConfiguration;
    readonly #fetch: typeof fetch;
    readonly #metadata: ReturnType<typeof createHappyMachineMetadata>;
    #metadataBase: Record<string, unknown> = {};
    readonly #socketFactory: NonNullable<HappyMachineClientOptions["socketFactory"]>;
    readonly #spawnSession: HappyMachineClientOptions["spawnSession"];
    readonly #listWorkspaces: HappyMachineClientOptions["listWorkspaces"];
    #closed = false;
    readonly #closeController = new AbortController();
    #keepAliveTimer: NodeJS.Timeout | undefined;
    readonly #spawnRequestFingerprints = new Map<string, string>();
    readonly #pendingSpawns = new Map<string, Promise<HappySpawnSessionResult>>();
    #retryTimer: NodeJS.Timeout | undefined;
    #socket: HappyMachineSocket | undefined;

    constructor(options: HappyMachineClientOptions) {
        if (options.configuration.machineId === undefined) {
            throw new Error("Rig's Happy machine identity is unavailable.");
        }
        this.#configuration = options.configuration;
        this.#fetch = options.fetch ?? fetch;
        this.#metadata = createHappyMachineMetadata(options);
        this.#socketFactory =
            options.socketFactory ?? ((url, socketOptions) => io(url, socketOptions) as Socket);
        this.#spawnSession = options.spawnSession;
        this.#listWorkspaces = options.listWorkspaces;
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#closeController.abort();
        if (this.#keepAliveTimer !== undefined) clearInterval(this.#keepAliveTimer);
        if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
        this.#spawnRequestFingerprints.clear();
        this.#pendingSpawns.clear();
        this.#socket?.disconnect();
        this.#socket = undefined;
    }

    start(): void {
        if (this.#closed || this.#socket !== undefined || this.#retryTimer !== undefined) return;
        void this.#registerAndConnect().catch(() => this.#scheduleRetry());
    }

    async #registerAndConnect(): Promise<void> {
        const machineId = this.#configuration.machineId!;
        const key = encryptionKey(this.#configuration);
        const variant = this.#configuration.credentials.encryption.type;
        const encodedMetadata = encode(key, variant, this.#metadata);
        const daemonState = encode(key, variant, {
            pid: process.pid,
            startedAt: Date.now(),
            status: "running",
        });
        const encryption = this.#configuration.credentials.encryption;
        const dataEncryptionKey =
            encryption.type === "dataKey"
                ? Buffer.from(
                      wrapHappyDataKey(encryption.machineKey, encryption.publicKey),
                  ).toString("base64")
                : null;
        const response = await this.#fetch(`${this.#configuration.serverUrl}/v1/machines`, {
            body: JSON.stringify({
                daemonState,
                id: machineId,
                metadata: encodedMetadata,
                ...(dataEncryptionKey === null ? {} : { dataEncryptionKey }),
            }),
            headers: {
                Authorization: `Bearer ${this.#configuration.credentials.token}`,
                "Content-Type": "application/json",
                "X-Happy-Client": `rig-daemon/${readPackageVersion()}`,
            },
            method: "POST",
            signal: AbortSignal.any([
                AbortSignal.timeout(HTTP_TIMEOUT_MS),
                this.#closeController.signal,
            ]),
        });
        if (!response.ok) throw new Error(`Happy returned HTTP ${String(response.status)}.`);
        const body = (await response.json()) as unknown;
        const machine = readMachine(body);
        if (this.#closed) return;
        const remoteMetadata = decode(key, variant, machine.metadata);
        if (isRecord(remoteMetadata)) this.#metadataBase = remoteMetadata;
        this.#connect(machine.metadataVersion, machine.daemonStateVersion);
    }

    #connect(metadataVersion: number, daemonStateVersion: number): void {
        const machineId = this.#configuration.machineId!;
        const socket = this.#socketFactory(this.#configuration.serverUrl, {
            auth: {
                clientType: "machine-scoped",
                happyClient: `rig-daemon/${readPackageVersion()}`,
                machineId,
                token: this.#configuration.credentials.token,
            },
            autoConnect: false,
            path: "/v1/updates",
            reconnection: true,
            transports: ["websocket"],
            withCredentials: true,
        });
        socket.on("connect", () => {
            socket.emit("rpc-register", { method: `${machineId}:spawn-happy-session` });
            if (this.#listWorkspaces !== undefined) {
                socket.emit("rpc-register", { method: `${machineId}:list-happy-workspaces` });
            }
            this.#syncMetadata(metadataVersion, 0);
            this.#syncDaemonState(daemonStateVersion, 0);
            this.#sendAlive();
        });
        socket.on(
            "rpc-request",
            (request: unknown, callback: (response: string) => void) =>
                void this.#handleRpcRequest(request, callback),
        );
        this.#socket = socket;
        this.#keepAliveTimer = setInterval(() => this.#sendAlive(), KEEP_ALIVE_INTERVAL_MS);
        this.#keepAliveTimer.unref();
        socket.connect();
    }

    async #handleRpcRequest(request: unknown, callback: (response: string) => void): Promise<void> {
        const machineId = this.#configuration.machineId!;
        const key = encryptionKey(this.#configuration);
        const variant = this.#configuration.credentials.encryption.type;
        let response: HappySpawnSessionResult | HappyListWorkspacesResult;
        const method = isRecord(request) ? request.method : undefined;
        const isSpawn = method === `${machineId}:spawn-happy-session`;
        const isList =
            method === `${machineId}:list-happy-workspaces` && this.#listWorkspaces !== undefined;
        if (!isRecord(request) || (!isSpawn && !isList) || typeof request.params !== "string") {
            response = { errorMessage: "Happy sent an invalid Rig request.", type: "error" };
        } else {
            const params = decryptHappyPayload(
                key,
                variant,
                new Uint8Array(Buffer.from(request.params, "base64")),
            );
            if (params === undefined) {
                response = { errorMessage: "Happy sent an unreadable Rig request.", type: "error" };
            } else {
                try {
                    response = isList
                        ? await this.#listWorkspaces!(params)
                        : await this.#spawnOnce(params);
                } catch (error) {
                    if (isDatabaseFailure(error)) throw error;
                    response = {
                        errorMessage:
                            error instanceof Error
                                ? error.message
                                : "Rig could not start a session.",
                        type: "error",
                    };
                }
            }
        }
        callback(encode(key, variant, response));
    }

    async #spawnOnce(params: unknown): Promise<HappySpawnSessionResult> {
        const request = readSpawnRequest(params);
        if (request === undefined) {
            return await this.#spawnSession(params, this.#closeController.signal);
        }
        const clientRequestId = request.clientRequestId;
        const fingerprint = spawnRequestFingerprint(request);
        const rememberedFingerprint = this.#spawnRequestFingerprints.get(clientRequestId);
        if (rememberedFingerprint !== undefined && rememberedFingerprint !== fingerprint) {
            return {
                errorMessage:
                    "This client request ID was already used for a different session request.",
                type: "error",
            };
        }
        if (rememberedFingerprint === undefined) {
            if (this.#spawnRequestFingerprints.size >= MAX_REMEMBERED_SPAWN_REQUESTS) {
                const oldest = this.#spawnRequestFingerprints.keys().next().value;
                if (oldest !== undefined) this.#spawnRequestFingerprints.delete(oldest);
            }
            this.#spawnRequestFingerprints.set(clientRequestId, fingerprint);
        }
        const existing = this.#pendingSpawns.get(clientRequestId);
        if (existing !== undefined) return await existing;

        const spawn = Promise.resolve().then(() =>
            this.#spawnSession(params, this.#closeController.signal),
        );
        this.#pendingSpawns.set(clientRequestId, spawn);
        try {
            return await spawn;
        } finally {
            if (this.#pendingSpawns.get(clientRequestId) === spawn) {
                this.#pendingSpawns.delete(clientRequestId);
            }
        }
    }

    #scheduleRetry(): void {
        if (this.#closed || this.#retryTimer !== undefined) return;
        this.#retryTimer = setTimeout(() => {
            this.#retryTimer = undefined;
            this.start();
        }, RETRY_INTERVAL_MS);
        this.#retryTimer.unref();
    }

    #syncMetadata(version: number, attempt: number): void {
        if (this.#closed || this.#socket === undefined || attempt >= 3) return;
        const metadata = {
            ...this.#metadataBase,
            ...this.#metadata,
            ...(typeof this.#metadataBase.displayName === "string"
                ? { displayName: this.#metadataBase.displayName }
                : {}),
        };
        this.#socket.emit(
            "machine-update-metadata",
            {
                expectedVersion: version,
                machineId: this.#configuration.machineId,
                metadata: encode(
                    encryptionKey(this.#configuration),
                    this.#configuration.credentials.encryption.type,
                    metadata,
                ),
            },
            (answer: unknown) => {
                if (!isRecord(answer)) return;
                if (answer.result === "success") {
                    this.#metadataBase = metadata;
                    return;
                }
                if (
                    answer.result === "version-mismatch" &&
                    typeof answer.version === "number" &&
                    typeof answer.metadata === "string"
                ) {
                    const latest = decode(
                        encryptionKey(this.#configuration),
                        this.#configuration.credentials.encryption.type,
                        answer.metadata,
                    );
                    if (isRecord(latest)) this.#metadataBase = latest;
                    this.#syncMetadata(answer.version, attempt + 1);
                }
            },
        );
    }

    #syncDaemonState(version: number, attempt: number): void {
        if (this.#closed || this.#socket === undefined || attempt >= 3) return;
        this.#socket.emit(
            "machine-update-state",
            {
                daemonState: encode(
                    encryptionKey(this.#configuration),
                    this.#configuration.credentials.encryption.type,
                    { pid: process.pid, startedAt: Date.now(), status: "running" },
                ),
                expectedVersion: version,
                machineId: this.#configuration.machineId,
            },
            (answer: unknown) => {
                if (
                    isRecord(answer) &&
                    answer.result === "version-mismatch" &&
                    typeof answer.version === "number"
                ) {
                    this.#syncDaemonState(answer.version, attempt + 1);
                }
            },
        );
    }

    #sendAlive(): void {
        this.#socket?.emit("machine-alive", {
            machineId: this.#configuration.machineId,
            time: Date.now(),
        });
    }
}

function encode(key: Uint8Array, variant: "dataKey" | "legacy", value: unknown): string {
    return Buffer.from(encryptHappyPayload(key, variant, value)).toString("base64");
}

function decode(
    key: Uint8Array,
    variant: "dataKey" | "legacy",
    value: string | undefined,
): unknown {
    if (value === undefined) return undefined;
    return decryptHappyPayload(key, variant, new Uint8Array(Buffer.from(value, "base64")));
}

function encryptionKey(configuration: HappyConnectionConfiguration): Uint8Array {
    const encryption = configuration.credentials.encryption;
    return encryption.type === "dataKey" ? encryption.machineKey : encryption.secret;
}

function readMachine(value: unknown): {
    daemonStateVersion: number;
    metadata?: string;
    metadataVersion: number;
} {
    const machine = isRecord(value) && isRecord(value.machine) ? value.machine : undefined;
    if (
        machine === undefined ||
        typeof machine.metadataVersion !== "number" ||
        typeof machine.daemonStateVersion !== "number"
    ) {
        throw new Error("Happy returned an invalid machine.");
    }
    return {
        daemonStateVersion: machine.daemonStateVersion,
        ...(typeof machine.metadata === "string" ? { metadata: machine.metadata } : {}),
        metadataVersion: machine.metadataVersion,
    };
}

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSpawnRequest(params: unknown): HappySpawnSessionRequest | undefined {
    if (!Value.Check(happySpawnSessionRequestSchema, params)) return undefined;
    return params as HappySpawnSessionRequest;
}

function spawnRequestFingerprint(request: HappySpawnSessionRequest): string {
    // Directory approval intentionally is not part of the fingerprint: Happy
    // retries the same request ID after the user approves that one transition.
    return JSON.stringify([
        request.agent,
        request.directory,
        request.effort ?? null,
        request.modelId ?? null,
        request.permissionMode ?? null,
        request.providerId ?? null,
        request.type,
        request.worktree?.type ?? null,
        request.worktree?.name ?? null,
    ]);
}
