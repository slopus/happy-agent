import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hsalsa, secretbox } from "@noble/ciphers/salsa.js";
import { u8, u32 } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { WebSocketServer, type WebSocket } from "ws";

/** A local Happy mobile protocol peer with distinct accounts and real encrypted transport. */
export async function createMobileRelayFixture() {
    const approvals = new Map<string, { token: string; response: string }>();
    const keys = new Map<string, Uint8Array>();
    const machines = new Map<string, string>();
    const sockets = new Map<WebSocket, { token: string; clientType: string }>();
    const sessions = new Map<
        string,
        { id: string; token: string; tag: string; metadata: string; botId?: string }
    >();
    const incoming = new Map<string, object[]>();
    const outgoing = new Map<string, unknown[]>();
    const rejected = new Set<string>();
    const encode = (token: string, value: unknown) => {
        const nonce = randomBytes(24);
        return Buffer.concat([
            nonce,
            secretbox(keys.get(token)!, nonce).seal(Buffer.from(JSON.stringify(value))),
        ]).toString("base64");
    };
    const decode = (token: string, value: string): unknown => {
        const bundle = Buffer.from(value, "base64");
        return JSON.parse(
            Buffer.from(
                secretbox(keys.get(token)!, bundle.subarray(0, 24)).open(bundle.subarray(24)),
            ).toString(),
        );
    };
    const json = (response: ServerResponse, body: unknown, status = 200) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
    };
    const handle = async (request: IncomingMessage, response: ServerResponse) => {
        const url = new URL(request.url ?? "/", "http://mobile.test");
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const text = Buffer.concat(chunks).toString();
        const body = text === "" ? {} : JSON.parse(text);
        const token = request.headers.authorization?.slice("Bearer ".length) ?? "";
        if (url.pathname === "/v1/auth/request") {
            const approval = approvals.get(body.publicKey);
            json(
                response,
                approval === undefined
                    ? { state: "requested" }
                    : { state: "authorized", ...approval },
            );
        } else if (rejected.has(token)) {
            json(response, { error: "Unauthorized" }, 401);
        } else if (url.pathname === "/v1/machines") {
            machines.set(token, body.id);
            json(response, { machine: { metadataVersion: 1, daemonStateVersion: 1 } });
        } else if (url.pathname === "/v1/sessions") {
            const key = `${token}:${body.tag}`;
            let session = sessions.get(key);
            if (session === undefined) {
                const metadata = decode(token, body.metadata) as { bot?: { id: string } };
                session = {
                    id: `remote-${sessions.size}`,
                    token,
                    tag: body.tag,
                    metadata: body.metadata,
                    ...(metadata.bot === undefined ? {} : { botId: metadata.bot.id }),
                };
                sessions.set(key, session);
            }
            json(response, {
                session: { ...session, agentState: null, agentStateVersion: 0, metadataVersion: 0 },
            });
        } else if (/^\/v3\/sessions\/[^/]+\/messages$/.test(url.pathname)) {
            const id = url.pathname.split("/")[3]!;
            if (request.method === "GET") {
                json(response, {
                    hasMore: false,
                    messages: (incoming.get(id) ?? []).slice(
                        Number(url.searchParams.get("after_seq") ?? 0),
                    ),
                });
            } else {
                outgoing.set(id, [
                    ...(outgoing.get(id) ?? []),
                    ...body.messages.map((message: { content: string }) =>
                        decode(token, message.content),
                    ),
                ]);
                json(response, { success: true });
            }
        } else if (/^\/v1\/sessions\/[^/]+\/archive$/.test(url.pathname)) {
            json(response, { success: true });
        } else {
            json(response, { error: "Not found" }, 404);
        }
    };
    const server = createServer((request, response) => {
        void handle(request, response).catch(() =>
            json(response, { error: "Invalid fixture request" }, 400),
        );
    });
    const webSockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) =>
        webSockets.handleUpgrade(request, socket, head, (peer) =>
            webSockets.emit("connection", peer),
        ),
    );
    webSockets.on("connection", (socket: WebSocket) => {
        socket.send(
            `0${JSON.stringify({ maxPayload: 1_000_000, pingInterval: 25_000, pingTimeout: 20_000, sid: "fixture", upgrades: [] })}`,
        );
        socket.on("close", () => sockets.delete(socket));
        socket.on("message", (value) => {
            const packet = value.toString();
            if (packet.startsWith("40")) {
                const auth = JSON.parse(packet.slice(2));
                sockets.set(socket, auth);
                socket.send('40{"sid":"fixture"}');
                return;
            }
            const match = /^42(\d*)(\[.*)$/s.exec(packet);
            if (match?.[1]) {
                const [, payload] = JSON.parse(match[2]!);
                socket.send(
                    `43${match[1]}${JSON.stringify([{ result: "success", version: (payload.expectedVersion ?? 0) + 1 }])}`,
                );
            }
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string")
        throw new Error("Missing fixture address.");
    return {
        url: `http://127.0.0.1:${address.port}`,
        machines,
        sessions,
        outgoing,
        rejected,
        activeMachines: () =>
            [...sockets.values()]
                .filter((auth) => auth.clientType === "machine-scoped")
                .map((auth) => auth.token)
                .sort(),
        authorize(qr: string, token: string) {
            const publicKey = Buffer.from(qr.split("?")[1]!, "base64url");
            const secret = randomBytes(32);
            keys.set(token, secret);
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
            approvals.set(publicKey.toString("base64"), { token, response });
        },
        deliver(token: string, botId: string, text: string) {
            const session = [...sessions.values()].find(
                (session) => session.token === token && session.botId === botId,
            );
            if (session === undefined) throw new Error("The account has no session.");
            const messages = incoming.get(session.id) ?? [];
            const seq = messages.length + 1;
            messages.push({
                seq,
                id: `phone-${seq}`,
                localId: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                content: {
                    t: "encrypted",
                    c: encode(token, {
                        role: "user",
                        content: { type: "text", text },
                        meta: {
                            userId: "spoofed",
                            model: "gym/model",
                            modelProviderId: "gym",
                            effort: "medium",
                            permissionMode: "full_access",
                        },
                    }),
                },
            });
            incoming.set(session.id, messages);
            for (const [socket, auth] of sockets)
                if (auth.token === token) socket.send('42["update",{}]');
        },
        async close() {
            for (const socket of webSockets.clients) socket.terminate();
            await new Promise<void>((resolve) => webSockets.close(() => resolve()));
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
