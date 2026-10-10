import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hsalsa, secretbox } from "@noble/ciphers/salsa.js";
import { u8, u32 } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * A local Happy mobile protocol peer with distinct accounts and real encrypted transport.
 *
 * Deleting a machine behaves like the current Happy server: it deletes the sessions published for
 * that machine, remembers the deletion for registrations that ask, and tells the machine's own
 * connection. `legacyMachineDeletion` behaves like an older server that deletes only the machine.
 *
 * Session updates go to rooms, as on Happy: a session-scoped socket is in its own session's room,
 * and a machine socket joins rooms with `session-subscribe`. `sessionSubscribe: false` behaves
 * like an older server with no such handler, which never answers it; `answerSubscriptions`
 * changes that for later questions, as a reconnect reaching another server version would.
 */
export async function createMobileRelayFixture(
    options: { readonly legacyMachineDeletion?: boolean; readonly sessionSubscribe?: boolean } = {},
) {
    const approvals = new Map<string, { token: string; response: string }>();
    const keys = new Map<string, Uint8Array>();
    const machines = new Map<string, string>();
    const machineOwners = new Map<string, string>();
    const sockets = new Map<
        WebSocket,
        { token: string; clientType: string; machineId?: string; sessionId?: string }
    >();
    /** The session rooms each socket is in, which is where that session's updates go. */
    const rooms = new Map<WebSocket, Set<string>>();
    /** The RPC methods each socket registered. */
    const rpcMethods = new Map<WebSocket, Set<string>>();
    /** Every `session-subscribe` and `session-unsubscribe` a machine socket sent, in order. */
    const subscriptions: { kind: "subscribe" | "unsubscribe"; sids: string[] }[] = [];
    /** Every `update-metadata` received, by session id. */
    const metadataWrites: string[] = [];
    const endedSessions: string[] = [];
    let answersSubscriptions = options.sessionSubscribe !== false;
    /** The most session-scoped sockets each account had open at once. */
    const peakSessionSockets = new Map<string, number>();
    const sessions = new Map<
        string,
        {
            id: string;
            token: string;
            tag: string;
            metadata: string;
            version: number;
            botId?: string;
            machineId?: string;
        }
    >();
    /** Machines each account deleted, by id, for registrations that refuse to recreate them. */
    const deletedMachines = new Map<string, string>();
    const incoming = new Map<string, object[]>();
    const outgoing = new Map<string, unknown[]>();
    const rejected = new Set<string>();
    /** Every confirmed deletion, as `session:<id>` or `machine:<id>`, in the order Happy saw. */
    const deletions: string[] = [];
    /** Answers a DELETE with this status instead of performing it, when it returns one. */
    const faults: { delete?: (path: string) => number | undefined } = {};
    let nextSession = 0;
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
    /** Sends an update to every socket of the account in the session's room. */
    const toRoom = (token: string, sessionId: string, update: unknown) => {
        for (const [socket, auth] of sockets)
            if (auth.token === token && rooms.get(socket)?.has(sessionId))
                socket.send(`42${JSON.stringify(["update", update])}`);
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
        } else if (
            request.method === "DELETE" &&
            /^\/v1\/(?:sessions|machines)\/[^/]+$/.test(url.pathname)
        ) {
            const injected = faults.delete?.(url.pathname);
            if (injected !== undefined) {
                json(response, { error: "Injected failure" }, injected);
                return;
            }
            // Like Happy, only the owning account can delete, and anything else is not found.
            const [, , kind, id] = url.pathname.split("/");
            if (kind === "sessions") {
                const key = [...sessions.entries()].find(
                    ([, session]) => session.id === id && session.token === token,
                )?.[0];
                if (key === undefined) {
                    json(response, { error: "Session not found" }, 404);
                    return;
                }
                sessions.delete(key);
            } else {
                const published = options.legacyMachineDeletion
                    ? []
                    : [...sessions.entries()].filter(
                          ([, session]) => session.token === token && session.machineId === id,
                      );
                if (machineOwners.get(id!) !== token && published.length === 0) {
                    json(response, { error: "Machine not found" }, 404);
                    return;
                }
                for (const [key, session] of published) {
                    sessions.delete(key);
                    deletions.push(`session:${session.id}`);
                }
                if (machineOwners.get(id!) === token) {
                    machineOwners.delete(id!);
                    if (machines.get(token) === id) machines.delete(token);
                    deletions.push(`machine:${id!}`);
                    if (!options.legacyMachineDeletion) {
                        deletedMachines.set(id!, token);
                        const update = { body: { t: "delete-machine", machineId: id } };
                        for (const [socket, auth] of sockets)
                            if (auth.token === token && auth.machineId === id)
                                socket.send(`42${JSON.stringify(["update", update])}`);
                    }
                }
                json(response, { success: true });
                return;
            }
            deletions.push(`session:${id!}`);
            json(response, { success: true });
        } else if (url.pathname === "/v1/machines") {
            // Like Happy, a machine id is unique across accounts; only its first account may use it.
            const owner = machineOwners.get(body.id) ?? token;
            if (owner !== token) {
                json(
                    response,
                    {
                        code: "machine_id_taken",
                        error: "Machine id is registered to another account",
                    },
                    409,
                );
                return;
            }
            if (
                !machineOwners.has(body.id) &&
                body.failIfDeleted === true &&
                deletedMachines.get(body.id) === token
            ) {
                json(
                    response,
                    { code: "machine_deleted", error: "Machine was deleted from this account" },
                    410,
                );
                return;
            }
            deletedMachines.delete(body.id);
            machineOwners.set(body.id, token);
            machines.set(token, body.id);
            json(response, { machine: { metadataVersion: 1, daemonStateVersion: 1 } });
        } else if (url.pathname === "/v1/sessions") {
            const key = `${token}:${body.tag}`;
            let session = sessions.get(key);
            if (session === undefined) {
                const metadata = decode(token, body.metadata) as { bot?: { id: string } };
                session = {
                    id: `remote-${String(nextSession++)}`,
                    token,
                    tag: body.tag,
                    metadata: body.metadata,
                    version: 0,
                    ...(metadata.bot === undefined ? {} : { botId: metadata.bot.id }),
                };
                sessions.set(key, session);
            }
            if (typeof body.machineId === "string" && !options.legacyMachineDeletion) {
                session.machineId = body.machineId;
            }
            json(response, {
                session: {
                    ...session,
                    agentState: null,
                    agentStateVersion: 0,
                    metadataVersion: session.version,
                },
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
        socket.on("close", () => {
            sockets.delete(socket);
            rooms.delete(socket);
            rpcMethods.delete(socket);
        });
        socket.on("message", (value) => {
            const packet = value.toString();
            if (packet.startsWith("40")) {
                const auth = JSON.parse(packet.slice(2));
                sockets.set(socket, auth);
                if (auth.clientType === "session-scoped") {
                    const open = [...sockets.values()].filter(
                        (other) =>
                            other.token === auth.token && other.clientType === "session-scoped",
                    ).length;
                    peakSessionSockets.set(
                        auth.token,
                        Math.max(open, peakSessionSockets.get(auth.token) ?? 0),
                    );
                }
                rooms.set(
                    socket,
                    new Set(auth.clientType === "session-scoped" ? [auth.sessionId] : []),
                );
                rpcMethods.set(socket, new Set());
                socket.send('40{"sid":"fixture"}');
                return;
            }
            const match = /^42(\d*)(\[.*)$/s.exec(packet);
            if (match === null) return;
            const [event, payload] = JSON.parse(match[2]!);
            const auth = sockets.get(socket);
            const ack = (answer: unknown) => {
                if (match[1]) socket.send(`43${match[1]}${JSON.stringify([answer])}`);
            };
            if (auth === undefined) return;
            if (event === "session-subscribe") {
                // An older server has no handler, so the question is never answered.
                if (!answersSubscriptions) return;
                if (auth.clientType !== "machine-scoped") {
                    ack({ result: "error", reason: "unsupported-client" });
                    return;
                }
                const sids: unknown = payload?.sids;
                if (
                    !Array.isArray(sids) ||
                    sids.length === 0 ||
                    sids.length > 500 ||
                    sids.some((sid) => typeof sid !== "string")
                ) {
                    ack({ result: "error", reason: "invalid" });
                    return;
                }
                const requested = [...new Set(sids as string[])];
                const owned = new Set(
                    [...sessions.values()]
                        .filter((session) => session.token === auth.token)
                        .map((session) => session.id),
                );
                const subscribed = requested.filter((sid) => owned.has(sid));
                for (const sid of subscribed) rooms.get(socket)?.add(sid);
                subscriptions.push({ kind: "subscribe", sids: requested });
                ack({
                    result: "success",
                    subscribed,
                    missing: requested.filter((sid) => !owned.has(sid)),
                });
                return;
            }
            if (event === "session-unsubscribe") {
                for (const sid of payload.sids) rooms.get(socket)?.delete(sid);
                subscriptions.push({ kind: "unsubscribe", sids: payload.sids });
                ack({ result: "success" });
                return;
            }
            if (event === "rpc-register") rpcMethods.get(socket)?.add(payload.method);
            if (event === "rpc-unregister") rpcMethods.get(socket)?.delete(payload.method);
            if (event === "session-end") endedSessions.push(payload.sid);
            if (!match[1]) return;
            const session =
                event === "update-metadata"
                    ? [...sessions.values()].find((session) => session.id === payload.sid)
                    : undefined;
            if (event === "update-metadata") metadataWrites.push(payload.sid);
            let answer: unknown = {
                result: "success",
                version: (payload.expectedVersion ?? 0) + 1,
            };
            // Metadata is compared and set like the real relay, so a phone write in
            // between conflicts and the daemon must merge onto it.
            if (session !== undefined && payload.expectedVersion !== session.version) {
                answer = {
                    result: "version-mismatch",
                    metadata: session.metadata,
                    version: session.version,
                };
            } else if (session !== undefined) {
                session.metadata = payload.metadata;
                session.version += 1;
                answer = { result: "success", version: session.version };
                // Like Happy, the write is broadcast to the session's room, its writer included.
                toRoom(auth.token, session.id, {
                    body: {
                        t: "update-session",
                        id: session.id,
                        metadata: { value: session.metadata, version: session.version },
                    },
                });
            }
            ack(answer);
        });
    });
    const sessionOf = (token: string, botId: string) => {
        const session = [...sessions.values()].find(
            (session) => session.token === token && session.botId === botId,
        );
        if (session === undefined) throw new Error("The account has no session.");
        return session;
    };
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string")
        throw new Error("Missing fixture address.");
    const url = `http://127.0.0.1:${address.port}`;
    return {
        url,
        machines,
        sessions,
        outgoing,
        rejected,
        deletions,
        faults,
        subscriptions,
        metadataWrites,
        endedSessions,
        /** The session rooms the account's machine sockets are in. */
        machineRooms: (token: string) =>
            [...sockets.entries()]
                .filter(([, auth]) => auth.token === token && auth.clientType === "machine-scoped")
                .flatMap(([socket]) => [...(rooms.get(socket) ?? [])])
                .sort(),
        /** How many session-scoped sockets the account has open. */
        sessionSockets: (token: string) =>
            [...sockets.values()].filter(
                (auth) => auth.token === token && auth.clientType === "session-scoped",
            ).length,
        /** The RPC methods any of the account's sockets registered. */
        rpcMethods: (token: string) =>
            [...sockets.entries()]
                .filter(([, auth]) => auth.token === token)
                .flatMap(([socket]) => [...(rpcMethods.get(socket) ?? [])])
                .sort(),
        /** Drops the account's machine connection, as a network blip would; the client reconnects. */
        /** The most session-scoped sockets the account had open at once. */
        peakSessionSockets: (token: string) => peakSessionSockets.get(token) ?? 0,
        /** Whether later subscriptions are answered, as on a server that has the handler. */
        answerSubscriptions(enabled: boolean) {
            answersSubscriptions = enabled;
        },
        dropMachineSocket(token: string) {
            for (const [socket, auth] of sockets)
                if (auth.token === token && auth.clientType === "machine-scoped")
                    socket.terminate();
        },
        activeMachines: () =>
            [...sockets.values()]
                .filter((auth) => auth.clientType === "machine-scoped")
                .map((auth) => auth.token)
                .sort(),
        /** Approves a pairing; a token approved before keeps its account key, as the same phone would. */
        authorize(qr: string, token: string) {
            const publicKey = Buffer.from(qr.split("?")[1]!, "base64url");
            const secret = keys.get(token) ?? randomBytes(32);
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
        /** A session another client, such as Happy CLI, created on the same account. */
        addForeignSession(token: string, tag: string) {
            const session = {
                id: `remote-${String(nextSession++)}`,
                token,
                tag,
                metadata: encode(token, { path: "/terminal" }),
                version: 0,
            };
            sessions.set(`${token}:${tag}`, session);
            return session.id;
        },
        /** Deletes a machine as the account's phone does, through the same Happy request. */
        async deleteMachineFromPhone(token: string, machineId: string) {
            const response = await fetch(`${url}/v1/machines/${machineId}`, {
                headers: { authorization: `Bearer ${token}` },
                method: "DELETE",
            });
            await response.body?.cancel();
            return response.status;
        },
        /** The ids of every session the account holds. */
        accountSessions(token: string) {
            return [...sessions.values()]
                .filter((session) => session.token === token)
                .map((session) => session.id);
        },
        /** The ids of the account's sessions that publish a bot. */
        botSessions(token: string, botId: string) {
            return [...sessions.values()]
                .filter((session) => session.token === token && session.botId === botId)
                .map((session) => session.id);
        },
        /** The account's current session metadata as its phone would decrypt it. */
        metadata(token: string, botId: string) {
            return decode(token, sessionOf(token, botId).metadata) as Record<string, unknown>;
        },
        /** A phone-side metadata write: merged, versioned, and broadcast only to that account. */
        updateMetadata(token: string, botId: string, patch: Record<string, unknown>) {
            const session = sessionOf(token, botId);
            const current = decode(token, session.metadata) as Record<string, unknown>;
            session.metadata = encode(token, { ...current, ...patch });
            session.version += 1;
            toRoom(token, session.id, {
                body: {
                    t: "update-session",
                    id: session.id,
                    metadata: { value: session.metadata, version: session.version },
                },
            });
        },
        deliver(token: string, botId: string, text: string) {
            const session = sessionOf(token, botId);
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
            toRoom(token, session.id, {
                body: { t: "new-message", sid: session.id, message: messages.at(-1) },
            });
        },
        async close() {
            for (const socket of webSockets.clients) socket.terminate();
            await new Promise<void>((resolve) => webSockets.close(() => resolve()));
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
