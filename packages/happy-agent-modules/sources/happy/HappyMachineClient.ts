import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { connectHappySocket } from "./connectHappySocket.js";
import { createHappyMachineMetadata } from "./createHappyMachineMetadata.js";
import {
    decryptHappyPayload,
    encryptHappyPayload,
    wrapHappyDataKey,
} from "./crypto/happyEncryption.js";
import {
    handleHappySpawnSession,
    type HappySpawnOperations,
    type HappySpawnResult,
} from "./handleHappySpawnSession.js";
import type { HappyConnectionConfiguration, HappyEncryptionVariant } from "./HappyCredentials.js";
import type { HappyModel } from "./HappySession.js";
import type { HappySocket } from "./HappySessionClient.js";

const HTTP_TIMEOUT_MS = 15_000;
const RETRY_INTERVAL_MS = 5_000;
const KEEP_ALIVE_INTERVAL_MS = 20_000;

/** How long a spawned session is given to be published before the phone is told to wait. */
const SPAWN_PUBLISH_TIMEOUT_MS = 10_000;

export interface HappyMachineClientOptions {
    readonly configuration: HappyConnectionConfiguration;
    /** The lifetime this client's own work runs on; it outlives whoever created it. */
    readonly context: Context;
    readonly fetch?: typeof fetch;
    readonly operations: HappySpawnOperations;
    readonly models: () => readonly HappyModel[];
    /** The session Happy should open, once Happy Agent has published it. */
    readonly remoteSessionId: (agentId: string) => Promise<string | undefined>;
    /** Only a test supplies this; left out, the client opens its own connection to Happy. */
    readonly socketFactory?: (url: string, options: Record<string, unknown>) => HappySocket;
    readonly version: string;
}

const machineSchema = Type.Object(
    {
        machine: Type.Object(
            {
                daemonStateVersion: Type.Number(),
                metadata: Type.Optional(Type.String()),
                metadataVersion: Type.Number(),
            },
            { additionalProperties: true },
        ),
    },
    { additionalProperties: true },
);

const acknowledgementSchema = Type.Object(
    {
        metadata: Type.Optional(Type.String()),
        result: Type.Optional(Type.String()),
        version: Type.Optional(Type.Number()),
    },
    { additionalProperties: true },
);

const rpcRequestSchema = Type.Object(
    { method: Type.String(), params: Type.String() },
    { additionalProperties: true },
);

const recordSchema = Type.Record(Type.String(), Type.Unknown());

/**
 * This computer, as it appears in Happy.
 *
 * A machine is what a person picks before there is any session to pick: it says
 * this Happy Agent is here, what it can run, and that it will start something new when
 * asked. It keeps itself registered and reachable for as long as the daemon runs.
 */
export class HappyMachineClient {
    readonly #options: HappyMachineClientOptions;
    readonly #closeController = new AbortController();
    readonly #machineId: string;
    #closed = false;
    #keepAliveTimer: NodeJS.Timeout | undefined;
    #metadataBase: Record<string, unknown> = {};
    #retryTimer: NodeJS.Timeout | undefined;
    #socket: HappySocket | undefined;

    constructor(options: HappyMachineClientOptions) {
        const machineId = options.configuration.machineId;
        if (machineId === undefined) {
            throw new Error("Happy Agent has no Happy machine identity to register.");
        }
        this.#machineId = machineId;
        this.#options = options;
    }

    /** Registers this computer with Happy and keeps it reachable. */
    start(): void {
        if (this.#closed || this.#socket !== undefined || this.#retryTimer !== undefined) return;
        void this.#registerAndConnect().catch((error: unknown) => {
            this.#options.context.log.debug("Happy machine registration will retry.", {}, error);
            this.#scheduleRetry();
        });
    }

    /** Stops appearing in Happy and releases everything held for it. */
    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#closeController.abort();
        if (this.#keepAliveTimer !== undefined) clearInterval(this.#keepAliveTimer);
        if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
        this.#socket?.disconnect();
        this.#socket = undefined;
    }

    async #registerAndConnect(): Promise<void> {
        const metadata = createHappyMachineMetadata({
            configuration: this.#options.configuration,
            models: this.#options.models(),
            version: this.#options.version,
        });
        const encryption = this.#options.configuration.credentials.encryption;
        const dataEncryptionKey =
            encryption.type === "dataKey"
                ? Buffer.from(
                      wrapHappyDataKey(encryption.machineKey, encryption.publicKey),
                  ).toString("base64")
                : undefined;
        const response = await (this.#options.fetch ?? fetch)(
            `${this.#options.configuration.serverUrl}/v1/machines`,
            {
                body: JSON.stringify({
                    daemonState: this.#encode(this.#daemonState()),
                    ...(dataEncryptionKey === undefined ? {} : { dataEncryptionKey }),
                    id: this.#machineId,
                    metadata: this.#encode(metadata),
                }),
                headers: {
                    Authorization: `Bearer ${this.#options.configuration.credentials.token}`,
                    "Content-Type": "application/json",
                    "X-Happy-Client": `rig-daemon/${this.#options.version}`,
                },
                method: "POST",
                signal: AbortSignal.any([
                    AbortSignal.timeout(HTTP_TIMEOUT_MS),
                    this.#closeController.signal,
                ]),
            },
        );
        if (!response.ok) throw new Error(`Happy answered with HTTP ${String(response.status)}.`);
        const body: unknown = await response.json();
        if (!Value.Check(machineSchema, body)) {
            throw new Error("Happy returned a machine Happy Agent could not read.");
        }
        if (this.#closed) return;
        const remote = this.#decode(body.machine.metadata);
        if (Value.Check(recordSchema, remote)) this.#metadataBase = remote;
        this.#connect(body.machine.metadataVersion, body.machine.daemonStateVersion);
    }

    #connect(metadataVersion: number, daemonStateVersion: number): void {
        const socket = (this.#options.socketFactory ?? connectHappySocket)(
            this.#options.configuration.serverUrl,
            {
                auth: {
                    clientType: "machine-scoped",
                    happyClient: `rig-daemon/${this.#options.version}`,
                    machineId: this.#machineId,
                    token: this.#options.configuration.credentials.token,
                },
                autoConnect: false,
                path: "/v1/updates",
                reconnection: true,
                transports: ["websocket"],
                withCredentials: true,
            },
        );
        socket.on("connect", () => {
            socket.emit("rpc-register", { method: `${this.#machineId}:spawn-happy-session` });
            this.#syncMetadata(metadataVersion, 0);
            this.#syncDaemonState(daemonStateVersion, 0);
            this.#sendAlive();
        });
        socket.on("rpc-request", (request: unknown, callback: (response: string) => void) => {
            void this.#handleRpcRequest(request, callback);
        });
        this.#socket = socket;
        this.#keepAliveTimer = setInterval(() => this.#sendAlive(), KEEP_ALIVE_INTERVAL_MS);
        this.#keepAliveTimer.unref();
        socket.connect();
    }

    async #handleRpcRequest(request: unknown, callback: (response: string) => void): Promise<void> {
        let answer: HappySpawnResult;
        if (
            !Value.Check(rpcRequestSchema, request) ||
            request.method !== `${this.#machineId}:spawn-happy-session`
        ) {
            answer = {
                errorMessage: "Happy sent a request Happy Agent does not serve.",
                type: "error",
            };
        } else {
            answer = await handleHappySpawnSession({
                ctx: this.#options.context,
                operations: this.#options.operations,
                machineId: this.#machineId,
                models: this.#options.models(),
                params: this.#decode(request.params),
                remoteSessionId: (agentId) => this.#awaitRemoteSession(agentId),
                signal: this.#closeController.signal,
            });
        }
        callback(this.#encode(answer));
    }

    /**
     * Waits briefly for a freshly started session to reach Happy.
     *
     * Publishing takes a round trip of its own, and the phone is holding a
     * request open, so this waits only as long as is reasonable and then tells
     * the phone to ask again rather than leaving it hanging.
     */
    async #awaitRemoteSession(agentId: string): Promise<string | undefined> {
        const deadline = Date.now() + SPAWN_PUBLISH_TIMEOUT_MS;
        while (Date.now() < deadline && !this.#closed) {
            const remoteSessionId = await this.#options.remoteSessionId(agentId);
            if (remoteSessionId !== undefined) return remoteSessionId;
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, 250);
                timer.unref();
            });
        }
        return undefined;
    }

    #syncMetadata(version: number, attempt: number): void {
        if (this.#closed || this.#socket === undefined || attempt >= 3) return;
        const metadata = {
            ...this.#metadataBase,
            ...createHappyMachineMetadata({
                configuration: this.#options.configuration,
                models: this.#options.models(),
                version: this.#options.version,
            }),
            // The name is the person's to choose, so Happy Agent never writes over it.
            ...(typeof this.#metadataBase.displayName === "string"
                ? { displayName: this.#metadataBase.displayName }
                : {}),
        };
        this.#socket.emit(
            "machine-update-metadata",
            {
                expectedVersion: version,
                machineId: this.#machineId,
                metadata: this.#encode(metadata),
            },
            (answer: unknown) => {
                if (!Value.Check(acknowledgementSchema, answer)) return;
                if (answer.result === "success") {
                    this.#metadataBase = metadata;
                    return;
                }
                if (answer.result === "version-mismatch" && answer.version !== undefined) {
                    const latest = this.#decode(answer.metadata);
                    if (Value.Check(recordSchema, latest)) this.#metadataBase = latest;
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
                daemonState: this.#encode(this.#daemonState()),
                expectedVersion: version,
                machineId: this.#machineId,
            },
            (answer: unknown) => {
                if (
                    Value.Check(acknowledgementSchema, answer) &&
                    answer.result === "version-mismatch" &&
                    answer.version !== undefined
                ) {
                    this.#syncDaemonState(answer.version, attempt + 1);
                }
            },
        );
    }

    #sendAlive(): void {
        this.#socket?.emit("machine-alive", { machineId: this.#machineId, time: Date.now() });
    }

    #daemonState(): Record<string, unknown> {
        return { pid: process.pid, startedAt: Date.now(), status: "running" };
    }

    #scheduleRetry(): void {
        if (this.#closed || this.#retryTimer !== undefined) return;
        this.#retryTimer = setTimeout(() => {
            this.#retryTimer = undefined;
            this.start();
        }, RETRY_INTERVAL_MS);
        this.#retryTimer.unref();
    }

    #encode(value: unknown): string {
        return Buffer.from(encryptHappyPayload(this.#key(), this.#variant(), value)).toString(
            "base64",
        );
    }

    #decode(value: string | undefined): unknown {
        if (value === undefined) return undefined;
        return decryptHappyPayload(
            this.#key(),
            this.#variant(),
            new Uint8Array(Buffer.from(value, "base64")),
        );
    }

    #key(): Uint8Array {
        const encryption = this.#options.configuration.credentials.encryption;
        return encryption.type === "dataKey" ? encryption.machineKey : encryption.secret;
    }

    #variant(): HappyEncryptionVariant {
        return this.#options.configuration.credentials.encryption.type;
    }
}
