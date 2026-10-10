import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hsalsa, secretbox } from "@noble/ciphers/salsa.js";
import { u8, u32 } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { AgentProviders, withAgentDatabase } from "@slopus/happy-agent-base";
import { HappyAgentClient } from "@slopus/happy-agent-client";
import { io, type Socket } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

/**
 * Carries a daemon's sessions over its machine connection against a real Happy server.
 *
 * Start a Happy server that has `session-subscribe` and point this at it, for example
 * `HAPPY_AGENT_LIVE_HAPPY_SERVER_URL=http://127.0.0.1:3005 pnpm test:live:happy-server`.
 * It creates a throwaway account on that server.
 */
const SERVER_URL = process.env.HAPPY_AGENT_LIVE_HAPPY_SERVER_URL;

/** Every Socket.IO connection the daemon opens to Happy, by the client type it claims. */
const opened = vi.hoisted(() => [] as { clientType: string; socket: Socket }[]);

vi.mock("../../sources/happy/connectHappySocket.js", async (importOriginal) => {
    const original =
        await importOriginal<typeof import("../../sources/happy/connectHappySocket.js")>();
    return {
        connectHappySocket: (url: string, options: Record<string, unknown>) => {
            const socket = original.connectHappySocket(url, options) as unknown as Socket;
            const auth = options.auth as { clientType: string };
            opened.push({ clientType: auth.clientType, socket });
            return socket;
        },
    };
});

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Signs in a new account the way the phone does, with a fresh signing key. */
async function createAccount(serverUrl: string): Promise<string> {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const challenge = randomBytes(32);
    const response = await fetch(`${serverUrl}/v1/auth`, {
        body: JSON.stringify({
            challenge: challenge.toString("base64"),
            publicKey: raw.toString("base64"),
            signature: sign(null, challenge, privateKey).toString("base64"),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { token: string }).token;
}

/** Approves the daemon's pairing request with a legacy account secret, as an older phone does. */
async function approvePairing(serverUrl: string, token: string, qr: string, secret: Uint8Array) {
    const publicKey = Buffer.from(qr.split("?")[1]!, "base64url");
    const ephemeral = randomBytes(32);
    const derived = new Uint32Array(8);
    hsalsa(
        u32(Buffer.from("expand 32-byte k")),
        u32(x25519.getSharedSecret(ephemeral, publicKey)),
        new Uint32Array(4),
        derived,
    );
    const nonce = randomBytes(24);
    const response = Buffer.concat([
        x25519.getPublicKey(ephemeral),
        nonce,
        secretbox(u8(derived), nonce).seal(secret),
    ]).toString("base64");
    const answer = await fetch(`${serverUrl}/v1/auth/response`, {
        body: JSON.stringify({ publicKey: publicKey.toString("base64"), response }),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        method: "POST",
    });
    expect(answer.status).toBe(200);
}

function encrypt(secret: Uint8Array, value: unknown): string {
    const nonce = randomBytes(24);
    return Buffer.concat([
        nonce,
        secretbox(secret, nonce).seal(Buffer.from(JSON.stringify(value))),
    ]).toString("base64");
}

describe.skipIf(SERVER_URL === undefined)("a real Happy server", () => {
    it("carries every session over the machine connection, across a reconnect", async () => {
        const serverUrl = SERVER_URL!;
        const root = await mkdtemp(join(tmpdir(), "happy-live-multiplex-"));
        cleanups.push(async () => await rm(root, { force: true, recursive: true }));
        const happyHome = join(root, ".happy");
        const providers = new AgentProviders();
        providers.add("gym", new ScriptedProvider([]), "codex");
        const runtime: HappyAgentRuntime = await startHappyAgentRuntime({
            happyHome,
            environment: { HAPPY_HOME_DIR: happyHome, HAPPY_AGENT_HAPPY_SERVER_URL: serverUrl },
            inference: {
                providers,
                models: [
                    {
                        id: "gym/model",
                        providerId: "gym",
                        name: "Gym",
                        defaultEffort: "medium",
                        effortLevels: ["medium"],
                    },
                ],
            },
        });
        const server: Server = createServer((request, response) => {
            void runtime.api.handleRequest(
                withAgentDatabase(runtime.ctx.named("test.live-multiplex-http"), runtime.database),
                request,
                response,
            );
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        cleanups.push(async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await runtime.close();
        });
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Missing address.");
        const client = new HappyAgentClient({
            endpoint: `http://127.0.0.1:${String(address.port)}`,
            token: (await readFile(runtime.configuration.paths.tokenPath, "utf8")).trim(),
        });
        const { bot } = await client.createBot({ name: "Live multiplexed bot" });

        const token = await createAccount(serverUrl);
        const secret = randomBytes(32);
        const pairing = await client.startHappyIntegration();
        await approvePairing(serverUrl, token, pairing.integration.authorization!.data, secret);
        await vi.waitFor(
            async () =>
                expect((await client.getHappyIntegration()).integration.status).toBe("connected"),
            { timeout: 30_000, interval: 250 },
        );

        const machine = opened.find((entry) => entry.clientType === "machine-scoped")!.socket;
        const subscribed: string[][] = [];
        machine.onAnyOutgoing((event: string, payload: { sids?: string[] }) => {
            if (event === "session-subscribe") subscribed.push(payload.sids ?? []);
        });
        const routed: string[] = [];
        machine.on("update", (update: { body?: { t?: string; sid?: string } }) => {
            if (update.body?.t === "new-message" && update.body.sid !== undefined) {
                routed.push(update.body.sid);
            }
        });
        const sessionIds = async () => {
            const response = await fetch(`${serverUrl}/v1/sessions`, {
                headers: { authorization: `Bearer ${token}` },
            });
            return ((await response.json()) as { sessions: { id: string }[] }).sessions.map(
                (session) => session.id,
            );
        };
        await vi.waitFor(async () => expect(await sessionIds()).not.toHaveLength(0), {
            timeout: 30_000,
            interval: 250,
        });

        const phone = io(serverUrl, {
            auth: { clientType: "user-scoped", token },
            path: "/v1/updates",
            transports: ["websocket"],
        });
        cleanups.push(async () => {
            phone.disconnect();
        });
        await new Promise<void>((resolve) => phone.once("connect", () => resolve()));

        const roundTrip = async (text: string) => {
            for (const sid of await sessionIds()) {
                const response = await fetch(`${serverUrl}/v3/sessions/${sid}/messages`, {
                    body: JSON.stringify({
                        messages: [
                            {
                                content: encrypt(secret, {
                                    role: "user",
                                    content: { type: "text", text },
                                    meta: {
                                        model: "gym/model",
                                        modelProviderId: "gym",
                                        effort: "medium",
                                        permissionMode: "full_access",
                                    },
                                }),
                                localId: randomBytes(8).toString("hex"),
                            },
                        ],
                    }),
                    headers: {
                        authorization: `Bearer ${token}`,
                        "content-type": "application/json",
                    },
                    method: "POST",
                });
                expect(response.status).toBe(200);
            }
            await vi.waitFor(
                async () => {
                    const history = await client.getMessages(bot.agent.id);
                    expect(JSON.stringify(history.runs.flatMap((run) => run.messages))).toContain(
                        text,
                    );
                },
                { timeout: 15_000, interval: 250 },
            );
            // A session request reaches the daemon through the methods it registered on the
            // machine connection.
            const sid = (await sessionIds()).find((id) => routed.includes(id));
            expect(sid).toBeDefined();
            const answer = (await phone
                .timeout(10_000)
                .emitWithAck("rpc-call", { method: `${sid!}:gitState`, params: "" })) as {
                ok: boolean;
            };
            expect(answer.ok).toBe(true);
        };

        await roundTrip("Hello over the machine connection.");
        expect(opened.filter((entry) => entry.clientType !== "machine-scoped")).toEqual([]);

        // Rooms belong to one connection, so a reconnect must subscribe everything again.
        const before = subscribed.length;
        routed.length = 0;
        machine.io.engine.close();
        await vi.waitFor(() => expect(subscribed.length).toBeGreaterThan(before), {
            timeout: 30_000,
            interval: 250,
        });
        await roundTrip("Hello again after a reconnect.");
        expect(opened.filter((entry) => entry.clientType !== "machine-scoped")).toEqual([]);
    }, 180_000);
});
