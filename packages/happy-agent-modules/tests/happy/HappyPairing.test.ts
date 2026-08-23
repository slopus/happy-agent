import { afterEach, describe, expect, it, vi } from "vitest";

import { HappyPairing, HappyPairingError, wrapHappyDataKey } from "../../sources/happy/index.js";

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
        status,
    });
}

function scriptedAuthorization(plaintext: Uint8Array): {
    readonly fetch: typeof fetch;
    readonly requests: { readonly publicKey: string; readonly supportsV2: boolean }[];
} {
    const requests: { publicKey: string; supportsV2: boolean }[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
            publicKey: string;
            supportsV2: boolean;
        };
        requests.push(body);
        if (requests.length === 1) return json({ state: "requested" });
        const recipient = new Uint8Array(Buffer.from(body.publicKey, "base64"));
        const bundle = wrapHappyDataKey(plaintext, recipient).slice(1);
        return json({
            response: Buffer.from(bundle).toString("base64"),
            state: "authorized",
            token: "happy-token",
        });
    };
    return { fetch, requests };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("HappyPairing", () => {
    it("registers a v2 request and returns legacy credentials authorized by the QR key", async () => {
        const secret = new Uint8Array(32).fill(7);
        const server = scriptedAuthorization(secret);
        const random = new Uint8Array(32).fill(3);
        const pairing = await HappyPairing.start({
            fetch: server.fetch,
            pollIntervalMs: 0,
            randomBytes: () => random.slice(),
            serverUrl: "https://happy.example/",
            version: "1.2.3",
        });

        await expect(pairing.result).resolves.toEqual({
            secret: Buffer.from(secret).toString("base64"),
            token: "happy-token",
        });
        expect(server.requests).toHaveLength(2);
        expect(server.requests[0]).toEqual({
            publicKey: server.requests[1]?.publicKey,
            supportsV2: true,
        });
        expect(pairing.authorization).toEqual({
            data: `happy://terminal?${Buffer.from(
                server.requests[0]?.publicKey ?? "",
                "base64",
            ).toString("base64url")}`,
            expiresAt: expect.any(Number),
            kind: "qr",
        });
    });

    it("creates a fresh machine key for an authorized data-key account", async () => {
        const accountPublicKey = new Uint8Array(32).fill(5);
        const server = scriptedAuthorization(new Uint8Array([0, ...accountPublicKey]));
        let randomCall = 0;
        const pairing = await HappyPairing.start({
            fetch: server.fetch,
            pollIntervalMs: 0,
            randomBytes: () => new Uint8Array(32).fill(++randomCall),
            serverUrl: "https://happy.example",
            version: "1.2.3",
        });

        await expect(pairing.result).resolves.toEqual({
            encryption: {
                machineKey: Buffer.alloc(32, 2).toString("base64"),
                publicKey: Buffer.from(accountPublicKey).toString("base64"),
            },
            token: "happy-token",
        });
    });

    it("rejects an authorization bundle whose decrypted shape is not exact", async () => {
        const server = scriptedAuthorization(new Uint8Array(34).fill(8));
        const pairing = await HappyPairing.start({
            fetch: server.fetch,
            pollIntervalMs: 0,
            randomBytes: () => new Uint8Array(32).fill(4),
            serverUrl: "https://happy.example",
            version: "1.2.3",
        });

        const error = await pairing.result.catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(HappyPairingError);
        expect((error as HappyPairingError).code).toBe("invalid_response");
    });

    it("does not expose a QR code when Happy cannot create the request", async () => {
        await expect(
            HappyPairing.start({
                fetch: async () => json({}, 503),
                randomBytes: () => new Uint8Array(32).fill(1),
                serverUrl: "https://happy.example",
                version: "1.2.3",
            }),
        ).rejects.toMatchObject({ code: "happy_unavailable" });
    });

    it("rejects an oversized authorization response before retaining it", async () => {
        await expect(
            HappyPairing.start({
                fetch: async () => json({ padding: "x".repeat(70_000), state: "requested" }),
                randomBytes: () => new Uint8Array(32).fill(1),
                serverUrl: "https://happy.example",
                version: "1.2.3",
            }),
        ).rejects.toMatchObject({ code: "invalid_response" });
    });

    it("rejects authorization strings outside their bounded schema", async () => {
        await expect(
            HappyPairing.start({
                fetch: async () =>
                    json({
                        response: "ignored",
                        state: "authorized",
                        token: "x".repeat(20_000),
                    }),
                randomBytes: () => new Uint8Array(32).fill(1),
                serverUrl: "https://happy.example",
                version: "1.2.3",
            }),
        ).rejects.toMatchObject({ code: "invalid_response" });
    });

    it("settles cancellation even when authorization is still pending", async () => {
        const pairing = await HappyPairing.start({
            fetch: async () => json({ state: "requested" }),
            pollIntervalMs: 60_000,
            randomBytes: () => new Uint8Array(32).fill(1),
            serverUrl: "https://happy.example",
            version: "1.2.3",
        });
        const cancelled = expect(pairing.result).rejects.toMatchObject({ code: "cancelled" });

        pairing.close();

        await cancelled;
    });

    it("rejects a pending initial response at its absolute deadline", async () => {
        await expect(
            HappyPairing.start({
                expiresInMs: 0,
                fetch: async () => json({ state: "requested" }),
                randomBytes: () => new Uint8Array(32).fill(2),
                serverUrl: "https://happy.example",
                version: "1.2.3",
            }),
        ).rejects.toMatchObject({ code: "authorization_expired" });
    });

    it("rejects an initially authorized response that completes at the deadline", async () => {
        let now = 1_000;
        await expect(
            HappyPairing.start({
                expiresInMs: 25,
                fetch: async () => {
                    now = 1_025;
                    return json({ response: "ignored", state: "authorized", token: "late-token" });
                },
                now: () => now,
                randomBytes: () => new Uint8Array(32).fill(6),
                serverUrl: "https://happy.example",
                version: "1.2.3",
            }),
        ).rejects.toMatchObject({ code: "authorization_expired" });
    });

    it("bounds the request by the pairing deadline and classifies its abort as expiry", async () => {
        const deadline = new AbortController();
        const timeoutDurations: number[] = [];
        vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
            timeoutDurations.push(milliseconds);
            return deadline.signal;
        });
        const started = HappyPairing.start({
            expiresInMs: 40,
            fetch: pendingFetch(),
            now: () => 2_000,
            randomBytes: () => new Uint8Array(32).fill(7),
            requestTimeoutMs: 5_000,
            serverUrl: "https://happy.example",
            version: "1.2.3",
        });
        const rejected = expect(started).rejects.toMatchObject({
            code: "authorization_expired",
        });

        expect(timeoutDurations).toEqual([40]);
        deadline.abort(new DOMException("The pairing deadline passed.", "TimeoutError"));
        await rejected;
    });

    it("keeps a shorter request-timeout abort classified as unavailable", async () => {
        const requestTimeout = new AbortController();
        const timeoutDurations: number[] = [];
        vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
            timeoutDurations.push(milliseconds);
            return requestTimeout.signal;
        });
        const started = HappyPairing.start({
            expiresInMs: 5_000,
            fetch: pendingFetch(),
            now: () => 3_000,
            randomBytes: () => new Uint8Array(32).fill(8),
            requestTimeoutMs: 30,
            serverUrl: "https://happy.example",
            version: "1.2.3",
        });
        const rejected = expect(started).rejects.toMatchObject({ code: "happy_unavailable" });

        expect(timeoutDurations).toEqual([30]);
        requestTimeout.abort(new DOMException("The request timed out.", "TimeoutError"));
        await rejected;
    });
});

function pendingFetch(): typeof fetch {
    return async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal === undefined || signal === null) {
                reject(new Error("The authorization request had no abort signal."));
                return;
            }
            if (signal.aborted) {
                reject(signal.reason);
                return;
            }
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
}
