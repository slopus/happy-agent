import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    decryptHappyPayload,
    encryptHappyPayload,
    HappyMachineClient,
    type HappyConnectionConfiguration,
    type HappyMachineConnectionEvent,
    type HappyModel,
    type HappySpawnOperations,
    type HappySpawnRequest,
    type HappySpawnResult,
    type HappySocket,
} from "../../sources/happy/index.js";

vi.mock("../../sources/happy/credentials/readHappyCliMachineId.js", () => ({
    readHappyCliMachineId: async () => undefined,
}));

const KEY = Buffer.alloc(32, 7);
const SERVER = "https://api.happy.example";

const CONFIGURATION: HappyConnectionConfiguration = {
    credentialFingerprint: "credential-fingerprint",
    credentials: {
        encryption: { secret: new Uint8Array(KEY), type: "legacy" },
        token: "happy-token",
    },
    credentialsPath: "/tmp/happy/access.key",
    happyHome: "/tmp/happy",
    imported: false,
    machineId: "machine-1",
    serverUrl: SERVER,
};

const MODELS: readonly HappyModel[] = [
    {
        defaultEffort: "medium",
        effortLevels: ["low", "medium"],
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        providerId: "codex",
        serviceTiers: [],
    },
];

function decode(value: string): Record<string, unknown> {
    return decryptHappyPayload(
        new Uint8Array(KEY),
        "legacy",
        new Uint8Array(Buffer.from(value, "base64")),
    ) as Record<string, unknown>;
}

function encode(value: unknown): string {
    return Buffer.from(encryptHappyPayload(new Uint8Array(KEY), "legacy", value)).toString(
        "base64",
    );
}

class FakeSocket implements HappySocket {
    readonly #listeners = new Map<string, (...values: any[]) => void>();
    readonly emitted: { event: string; value: unknown }[] = [];
    acknowledgements: unknown[] = [];
    connected = false;
    disconnectCount = 0;

    connect(): void {
        this.connected = true;
        this.#listeners.get("connect")?.();
    }

    disconnect(): void {
        this.connected = false;
        this.disconnectCount += 1;
    }

    emit(event: string, ...values: unknown[]): void {
        this.emitted.push({ event, value: values[0] });
        const callback = values[1];
        if (typeof callback === "function") {
            (callback as (answer: unknown) => void)(
                this.acknowledgements.shift() ?? { result: "success", version: 1 },
            );
        }
    }

    on(event: string, listener: (...values: any[]) => void): void {
        this.#listeners.set(event, listener);
    }

    trigger(event: "connect" | "connect_error" | "disconnect"): void {
        this.connected = event === "connect";
        this.#listeners.get(event)?.();
    }

    /** Plays the Happy server forwarding one machine RPC from the phone. */
    async rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
        const listener = this.#listeners.get("rpc-request");
        if (listener === undefined) throw new Error("The client registered no RPC listener.");
        return await new Promise((resolve) => {
            listener({ method, params: encode(params) }, (answer: string) => {
                resolve(decode(answer));
            });
        });
    }

    /** Every metadata document this client published, oldest first. */
    published(): Record<string, unknown>[] {
        return this.emitted
            .filter((one) => one.event === "machine-update-metadata")
            .map((one) => decode((one.value as { metadata: string }).metadata));
    }
}

const clients = new Set<HappyMachineClient>();

afterEach(() => {
    for (const client of clients) client.close();
    clients.clear();
});

function client(options: {
    fetch: typeof fetch;
    onConnectionChanged?: (event: HappyMachineConnectionEvent) => void;
    operations?: HappySpawnOperations;
    remoteSessionId?: (agentId: string) => Promise<string | undefined>;
    socket: FakeSocket | (() => FakeSocket);
}): HappyMachineClient {
    const { socket } = options;
    const machine = new HappyMachineClient({
        configuration: CONFIGURATION,
        context: createRootContext().named("happy-machine-test"),
        fetch: options.fetch,
        models: () => MODELS,
        ...(options.onConnectionChanged === undefined
            ? {}
            : { onConnectionChanged: options.onConnectionChanged }),
        operations:
            options.operations ??
            ({
                defaultSpawnPermissionMode: () => "auto",
                readSpawnResult: () => undefined,
                rememberSpawnResult: () => undefined,
                spawnSession: async () => ({ agentId: "agent-1", type: "ready" }),
            } satisfies HappySpawnOperations),
        remoteSessionId: options.remoteSessionId ?? (async () => undefined),
        socketFactory: () => (typeof socket === "function" ? socket() : socket),
        version: "1.2.3",
    });
    clients.add(machine);
    return machine;
}

const REGISTERED = () =>
    new Response(JSON.stringify({ machine: { daemonStateVersion: 1, metadataVersion: 1 } }), {
        status: 200,
    });

async function connected(
    options: {
        operations?: HappySpawnOperations;
        remoteSessionId?: (agentId: string) => Promise<string | undefined>;
    } = {},
): Promise<{ socket: FakeSocket }> {
    const socket = new FakeSocket();
    const machine = client({
        fetch: (async () =>
            Response.json({
                machine: { daemonStateVersion: 1, id: "machine-1", metadataVersion: 4 },
            })) as unknown as typeof fetch,
        ...(options.operations === undefined ? {} : { operations: options.operations }),
        ...(options.remoteSessionId === undefined
            ? {}
            : { remoteSessionId: options.remoteSessionId }),
        socket,
    });
    machine.start();
    await vi.waitFor(() => expect(socket.connected).toBe(true));
    return { socket };
}

describe("starting Happy Agent work through the machine RPC", () => {
    it("routes the new discriminator through the existing spawn-happy-session method", async () => {
        const started: HappySpawnRequest[] = [];
        const served = new Map<string, HappySpawnResult>();
        const operations: HappySpawnOperations = {
            defaultSpawnPermissionMode: () => "auto",
            readSpawnResult: (clientRequestId) => served.get(clientRequestId),
            rememberSpawnResult: (clientRequestId, result) => {
                served.set(clientRequestId, result);
            },
            spawnSession: async (_ctx, request) => {
                started.push(request);
                return { agentId: request.sessionId, type: "ready" };
            },
        };
        const { socket } = await connected({
            operations,
            remoteSessionId: async () => "remote-1",
        });

        await expect(
            socket.rpc("machine-1:spawn-happy-session", {
                clientRequestId: "phone-1",
                target: { id: "project-1", kind: "project" },
                type: "happy-agent-spawn",
            }),
        ).resolves.toEqual({ sessionId: "remote-1", type: "success" });
        expect(started).toHaveLength(1);
        expect(started[0]).toMatchObject({ target: { id: "project-1", kind: "project" } });
        expect(
            socket.emitted.some(
                (entry) =>
                    entry.event === "rpc-register" &&
                    (entry.value as { method?: string }).method === "machine-1:spawn-happy-session",
            ),
        ).toBe(true);
    });
});

describe("keeping Happy's picture of this computer current", () => {
    it("describes this computer without listing the work on it", async () => {
        // The phone reads where a session may start from the sessions, so this document stays
        // about the machine itself and does not grow with every workspace somebody makes.
        const { socket } = await connected();
        const published = socket.published()[0];
        expect(published?.host).toBeDefined();
        expect(published?.projects).toBeUndefined();
        expect(published?.workspaces).toBeUndefined();
    });
});

/**
 * Registration answers without a real body.
 *
 * A streamed body settles on turns of its own, which a fake-timer test cannot
 * account for; these resolve on plain microtasks so every step below is
 * reached deliberately rather than waited for.
 */
function registeredAnswer(): Response {
    return {
        json: async () => ({ machine: { daemonStateVersion: 1, metadataVersion: 1 } }),
        ok: true,
        status: 200,
    } as unknown as Response;
}

function refusedAnswer(status: number): Response {
    return { json: async () => ({}), ok: false, status } as unknown as Response;
}

/** Runs the timers due within `milliseconds`, then lets everything they woke settle. */
async function settle(milliseconds = 0): Promise<void> {
    await vi.advanceTimersByTimeAsync(milliseconds);
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

const RETRY_INTERVAL_MS = 5_000;
const KEEP_ALIVE_INTERVAL_MS = 20_000;

describe("HappyMachineClient connection state", () => {
    it("announces socket connection, loss, and reconnection without duplicate losses", async () => {
        const socket = new FakeSocket();
        const events: HappyMachineConnectionEvent[] = [];
        const machine = client({
            fetch: async () => REGISTERED(),
            onConnectionChanged: (event) => events.push(event),
            socket,
        });

        machine.start();
        await vi.waitFor(() => expect(events.at(-1)).toEqual({ status: "connected" }));
        socket.trigger("disconnect");
        socket.trigger("disconnect");
        socket.trigger("connect");

        expect(events).toEqual([
            { status: "connecting" },
            { status: "connected" },
            {
                message: "The connection to Happy was lost.",
                reason: "happy_unavailable",
                status: "disconnected",
            },
            { status: "connected" },
        ]);
        machine.close();
    });

    it("reports rejected credentials and does not keep registering them", async () => {
        const socket = new FakeSocket();
        const events: HappyMachineConnectionEvent[] = [];
        const fetch = vi.fn<typeof globalThis.fetch>(
            async () => new Response(null, { status: 401 }),
        );
        const machine = client({
            fetch,
            onConnectionChanged: (event) => events.push(event),
            socket,
        });

        machine.start();
        await vi.waitFor(() =>
            expect(events.at(-1)).toMatchObject({ reason: "credentials_rejected" }),
        );

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(events).toEqual([
            { status: "connecting" },
            {
                message: "Happy rejected the saved credentials.",
                reason: "credentials_rejected",
                status: "disconnected",
            },
        ]);
        machine.close();
    });
});

describe("HappyMachineClient socket revalidation", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("registers again after a connect error and stops once Happy refuses the credentials", async () => {
        const sockets: FakeSocket[] = [];
        const events: HappyMachineConnectionEvent[] = [];
        const fetch = vi
            .fn<typeof globalThis.fetch>()
            .mockResolvedValueOnce(registeredAnswer())
            .mockResolvedValue(refusedAnswer(401));
        const machine = client({
            fetch,
            onConnectionChanged: (event) => events.push(event),
            socket: () => {
                const socket = new FakeSocket();
                sockets.push(socket);
                return socket;
            },
        });

        machine.start();
        await settle();
        expect(sockets).toHaveLength(1);
        expect(events.at(-1)).toEqual({ status: "connected" });

        sockets[0]?.trigger("connect_error");
        // The socket that never opened is abandoned rather than left reconnecting.
        expect(sockets[0]?.disconnectCount).toBe(1);
        expect(fetch).toHaveBeenCalledTimes(1);

        await settle(RETRY_INTERVAL_MS);
        // The whole registration is made again, and Happy refuses it.
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(sockets).toHaveLength(1);

        await settle(10 * RETRY_INTERVAL_MS);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(events).toEqual([
            { status: "connecting" },
            { status: "connected" },
            {
                message: "The Happy machine connection is unavailable.",
                reason: "happy_unavailable",
                status: "disconnected",
            },
            { status: "connecting" },
            {
                message: "Happy rejected the saved credentials.",
                reason: "credentials_rejected",
                status: "disconnected",
            },
        ]);
        machine.close();
    });

    it("connects again when the repeated registration succeeds", async () => {
        const sockets: FakeSocket[] = [];
        const events: HappyMachineConnectionEvent[] = [];
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(registeredAnswer());
        const machine = client({
            fetch,
            onConnectionChanged: (event) => events.push(event),
            socket: () => {
                const socket = new FakeSocket();
                sockets.push(socket);
                return socket;
            },
        });

        machine.start();
        await settle();
        sockets[0]?.trigger("connect_error");
        await settle(RETRY_INTERVAL_MS);

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(sockets).toHaveLength(2);
        expect(sockets[1]?.connected).toBe(true);
        expect(events.at(-1)).toEqual({ status: "connected" });
        machine.close();
    });

    it("ignores a socket it has already abandoned", async () => {
        const sockets: FakeSocket[] = [];
        const events: HappyMachineConnectionEvent[] = [];
        const machine = client({
            fetch: async () => registeredAnswer(),
            onConnectionChanged: (event) => events.push(event),
            socket: () => {
                const socket = new FakeSocket();
                sockets.push(socket);
                return socket;
            },
        });

        machine.start();
        await settle();
        const abandoned = sockets[0];
        abandoned?.trigger("connect_error");
        const emittedWhenAbandoned = abandoned?.emitted.length ?? 0;
        const eventsWhenAbandoned = events.length;

        // Everything the dead socket still says arrives after it stopped counting.
        abandoned?.trigger("connect");
        abandoned?.trigger("disconnect");
        abandoned?.trigger("connect_error");
        await settle(3 * KEEP_ALIVE_INTERVAL_MS);

        expect(abandoned?.emitted).toHaveLength(emittedWhenAbandoned);
        expect(events).toHaveLength(eventsWhenAbandoned + 2);
        expect(events.slice(eventsWhenAbandoned)).toEqual([
            { status: "connecting" },
            { status: "connected" },
        ]);
        machine.close();
    });
});
