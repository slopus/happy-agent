import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    HappyMachineClient,
    type HappyConnectionConfiguration,
    type HappyMachineConnectionEvent,
    type HappyModel,
    type HappySocket,
} from "../../sources/happy/index.js";

const CONFIGURATION: HappyConnectionConfiguration = {
    credentialFingerprint: "credential-fingerprint",
    credentials: {
        encryption: { secret: new Uint8Array(32).fill(4), type: "legacy" },
        token: "happy-token",
    },
    credentialsPath: "/tmp/happy/access.key",
    happyHome: "/tmp/happy",
    imported: false,
    machineId: "machine-1",
    serverUrl: "https://happy.example",
};

const MODELS: readonly HappyModel[] = [
    {
        defaultEffort: "medium",
        effortLevels: ["medium"],
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        providerId: "codex",
        serviceTiers: [],
    },
];

class FakeSocket implements HappySocket {
    readonly #listeners = new Map<string, (...values: any[]) => void>();
    /** Every event name this socket was asked to send, in order. */
    readonly emitted: string[] = [];
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
        this.emitted.push(event);
        const callback = values[1];
        if (typeof callback === "function") {
            (callback as (answer: unknown) => void)({ result: "success", version: 1 });
        }
    }

    on(event: string, listener: (...values: any[]) => void): void {
        this.#listeners.set(event, listener);
    }

    trigger(event: "connect" | "connect_error" | "disconnect"): void {
        this.connected = event === "connect";
        this.#listeners.get(event)?.();
    }
}

function client(options: {
    fetch: typeof fetch;
    onConnectionChanged: (event: HappyMachineConnectionEvent) => void;
    socket: FakeSocket | (() => FakeSocket);
}): HappyMachineClient {
    const { socket } = options;
    return new HappyMachineClient({
        configuration: CONFIGURATION,
        context: createRootContext().named("happy-machine-test"),
        fetch: options.fetch,
        models: () => MODELS,
        onConnectionChanged: options.onConnectionChanged,
        operations: { spawnSession: async () => ({ agentId: "agent-1" }) },
        remoteSessionId: async () => undefined,
        socketFactory: () => (typeof socket === "function" ? socket() : socket),
        version: "1.2.3",
    });
}

const REGISTERED = () =>
    new Response(JSON.stringify({ machine: { daemonStateVersion: 1, metadataVersion: 1 } }), {
        status: 200,
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
