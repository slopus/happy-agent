import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HappyConnectionConfiguration, HappySocket } from "../../sources/happy/index.js";
import {
    HappySessionSockets,
    type HappySessionTransport,
} from "../../sources/happy/HappySessionSockets.js";

const CONFIGURATION: HappyConnectionConfiguration = {
    credentialFingerprint: "credential-fingerprint",
    credentials: { encryption: { secret: new Uint8Array(32), type: "legacy" }, token: "token" },
    credentialsPath: "/tmp/happy/access.key",
    happyHome: "/tmp/happy",
    imported: false,
    machineId: "machine-1",
    serverUrl: "https://api.happy.example",
};

interface Sent {
    readonly event: string;
    readonly payload: unknown;
    readonly ack: ((answer: unknown) => void) | undefined;
}

/** A socket that records what is sent and lets the test answer each acknowledged event. */
function recordingSocket() {
    const sent: Sent[] = [];
    const listeners = new Map<string, (...values: any[]) => void>();
    let connected = false;
    const socket: HappySocket = {
        get connected() {
            return connected;
        },
        connect() {
            connected = true;
        },
        disconnect() {
            connected = false;
        },
        emit(event: string, ...values: unknown[]) {
            const last = values.at(-1);
            sent.push({
                event,
                payload: values[0],
                ack: typeof last === "function" ? (last as (answer: unknown) => void) : undefined,
            });
        },
        on(event: string, listener: (...values: any[]) => void) {
            listeners.set(event, listener);
        },
    };
    return { listeners, sent, socket };
}

function subscriptions(sent: readonly Sent[]) {
    return sent
        .filter((entry) => entry.event.startsWith("session-"))
        .map((entry) => ({ event: entry.event, payload: entry.payload }));
}

function createSockets(
    options: { onTransportChanged?: (transport: HappySessionTransport) => Promise<void> } = {},
) {
    const dedicated: ReturnType<typeof recordingSocket>[] = [];
    const sockets = new HappySessionSockets({
        configuration: CONFIGURATION,
        context: createRootContext().named("happy-session-sockets-test"),
        ...options,
        socketFactory: () => {
            const opened = recordingSocket();
            dedicated.push(opened);
            return opened.socket;
        },
        version: "test",
    });
    return { dedicated, sockets };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("carrying sessions over the machine connection", () => {
    it("never lets a reopened session inherit the answer its predecessor was waiting for", async () => {
        const { sockets } = createSockets();
        const machine = recordingSocket();
        const before = sockets.open("session-1");
        before.connect();
        sockets.connected(machine.socket);
        const probe = machine.sent[0]!;
        expect(probe.payload).toEqual({ sids: ["session-1"] });

        // The session stops and starts again while Happy has not yet answered the first question.
        before.disconnect();
        const after = sockets.open("session-1");
        const connects: number[] = [];
        after.on("connect", () => connects.push(1));
        after.connect();
        probe.ack!({ missing: [], result: "success", subscribed: ["session-1"] });
        await Promise.resolve();

        // Happy applied subscribe, then unsubscribe: the reopened link is not in the room yet and
        // asks for itself after the unsubscribe.
        expect(after.connected).toBe(false);
        expect(connects).toEqual([]);
        expect(subscriptions(machine.sent)).toEqual([
            { event: "session-subscribe", payload: { sids: ["session-1"] } },
            { event: "session-unsubscribe", payload: { sids: ["session-1"] } },
            { event: "session-subscribe", payload: { sids: ["session-1"] } },
        ]);
        machine.sent[2]!.ack!({ missing: [], result: "success", subscribed: ["session-1"] });
        expect(after.connected).toBe(true);
        expect(connects).toEqual([1]);
    });

    it("asks once more, after a pause, when Happy could not apply the first subscription", async () => {
        const { sockets } = createSockets();
        const machine = recordingSocket();
        const link = sockets.open("session-1");
        link.connect();
        sockets.connected(machine.socket);
        machine.sent[0]!.ack!({ reason: "internal", result: "error" });
        await Promise.resolve();
        expect(sockets.multiplexed).toBe(true);
        expect(subscriptions(machine.sent)).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(2_000);
        expect(subscriptions(machine.sent)).toEqual([
            { event: "session-subscribe", payload: { sids: ["session-1"] } },
            { event: "session-subscribe", payload: { sids: ["session-1"] } },
        ]);
        machine.sent[1]!.ack!({ missing: [], result: "success", subscribed: ["session-1"] });
        expect(link.connected).toBe(true);
    });

    it("opens no session socket until the owner has trimmed sessions the machine carried", async () => {
        let trimmed!: () => void;
        const changes: HappySessionTransport[] = [];
        const { dedicated, sockets } = createSockets({
            onTransportChanged: async (transport) => {
                changes.push(transport);
                await new Promise<void>((resolve) => {
                    trimmed = resolve;
                });
            },
        });
        const first = recordingSocket();
        const kept = sockets.open("session-1");
        const released = sockets.open("session-2");
        kept.connect();
        released.connect();
        sockets.connected(first.socket);
        first.sent[0]!.ack!({
            missing: [],
            result: "success",
            subscribed: ["session-1", "session-2"],
        });
        expect(changes).toEqual([]);

        // The reconnect reaches a server that never answers.
        sockets.disconnected();
        sockets.connected(recordingSocket().socket);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(changes).toEqual(["dedicated"]);
        expect(dedicated).toHaveLength(0);

        // Another reconnect decides the same while the owner is still letting sessions go.
        sockets.disconnected();
        sockets.connected(recordingSocket().socket);
        await vi.advanceTimersByTimeAsync(5_000);
        sockets.open("session-3").connect();
        expect(changes).toEqual(["dedicated"]);
        expect(dedicated).toHaveLength(0);

        released.disconnect();
        trimmed();
        await vi.advanceTimersByTimeAsync(0);
        expect(dedicated).toHaveLength(2);
        expect(kept.connected).toBe(true);
    });
});
