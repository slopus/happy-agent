import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    createHappySyncDatabase,
    encryptHappyPayload,
    decryptHappyPayload,
    happySessionTag,
    HappyMessageRefused,
    HappySessionClient,
    happySyncMigrations,
} from "../../sources/happy/index.js";
import type {
    HappyConnectionConfiguration,
    HappySessionOperations,
    HappyInboundMessage,
    HappyModel,
    HappySessionSnapshot,
    HappySocket,
    HappySyncDatabase,
} from "../../sources/happy/index.js";
import type { UserInputRequest } from "../../sources/userInput/index.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

const AGENT_ID = "agent-1";
const SESSION_ID = "session-1";
const SERVER = "https://api.happy.example";
const KEY = Buffer.alloc(32, 7).toString("base64");

const CONFIGURATION: HappyConnectionConfiguration = {
    credentialFingerprint: "credential-fingerprint",
    credentials: { encryption: { secret: new Uint8Array(32), type: "legacy" }, token: "token" },
    credentialsPath: "/tmp/happy/access.key",
    happyHome: "/tmp/happy",
    imported: false,
    machineId: "machine-1",
    serverUrl: SERVER,
};

const MODELS: readonly HappyModel[] = [
    {
        defaultEffort: "medium",
        effortLevels: ["low", "medium", "high"],
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        providerId: "codex",
        serviceTiers: [],
    },
];

function encode(value: unknown): string {
    return Buffer.from(
        encryptHappyPayload(new Uint8Array(Buffer.from(KEY, "base64")), "legacy", value),
    ).toString("base64");
}

function decode(value: string): unknown {
    return decryptHappyPayload(
        new Uint8Array(Buffer.from(KEY, "base64")),
        "legacy",
        new Uint8Array(Buffer.from(value, "base64")),
    );
}

/** A socket that records what was emitted and lets a test play the server's part. */
class FakeSocket implements HappySocket {
    connected = true;
    readonly emitted: { event: string; value: unknown }[] = [];
    readonly #listeners = new Map<string, (...values: any[]) => void>();
    /** What the next acknowledged emit answers with, in the order they are asked for. */
    acknowledgements: unknown[] = [];

    connect(): void {
        this.#listeners.get("connect")?.();
    }

    disconnect(): void {
        this.connected = false;
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

    /** Plays the server asking this session to do something. */
    async rpc(method: string, params: unknown): Promise<unknown> {
        const listener = this.#listeners.get("rpc-request");
        if (listener === undefined) throw new Error("The client registered no RPC listener.");
        return await new Promise((resolve) => {
            listener({ method, params: encode(params) }, (answer: string) => {
                resolve(answer === "" ? undefined : decode(answer));
            });
        });
    }

    /** Plays the server saying there is something new. */
    update(): void {
        this.#listeners.get("update")?.();
    }

    emittedValues(event: string): unknown[] {
        return this.emitted.filter((one) => one.event === event).map((one) => one.value);
    }
}

interface Call {
    readonly kind: string;
    readonly detail: unknown;
}

function fakeOperations(overrides: Partial<HappySessionOperations> = {}): {
    calls: Call[];
    operations: HappySessionOperations;
    pending: UserInputRequest[];
    snapshot: HappySessionSnapshot;
} {
    const calls: Call[] = [];
    const pending: UserInputRequest[] = [];
    const snapshot: HappySessionSnapshot = {
        agentId: AGENT_ID,
        archived: false,
        cwd: "/home/steve/projects/rig",
        modelId: "gpt-5.6-sol",
        permissionMode: "auto",
        projectName: "rig",
        providerId: "codex",
        sessionId: SESSION_ID,
        status: "running",
        title: "A session",
        tools: [],
        working: false,
    };
    const operations: HappySessionOperations = {
        abort: async () => {
            calls.push({ detail: undefined, kind: "abort" });
        },
        answerQuestion: async (_ctx, _agentId, requestId, answers) => {
            calls.push({ detail: { answers, requestId }, kind: "answer" });
        },
        archiveSession: async (_ctx, sessionId) => {
            calls.push({ detail: sessionId, kind: "archive" });
        },
        cancelQuestion: async (_ctx, _agentId, requestId) => {
            calls.push({ detail: requestId, kind: "cancel" });
        },
        models: () => MODELS,
        pendingQuestions: async () => pending,
        session: async () => snapshot,
        submit: async (_ctx, _agentId, message) => {
            calls.push({ detail: message, kind: "submit" });
        },
        ...overrides,
    };
    return { calls, operations, pending, snapshot };
}

/** A stand-in for Happy's HTTP API that answers exactly what a test tells it to. */
function fakeServer() {
    const requests: { body: unknown; method: string; url: string }[] = [];
    let remoteMessages: unknown[] = [];
    const handler = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init.method ?? "GET";
        const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
        requests.push({ body, method, url });
        if (url.endsWith("/v1/sessions") && method === "POST") {
            return Response.json({ session: { id: "remote-1", metadataVersion: 4 } });
        }
        if (url.includes("/messages") && method === "POST") {
            return Response.json({ ok: true });
        }
        if (url.includes("/messages")) {
            const page = { hasMore: false, messages: remoteMessages };
            remoteMessages = [];
            return Response.json(page);
        }
        if (url.endsWith("/archive")) return Response.json({ ok: true });
        return Response.json({});
    };
    return {
        fetch: handler as unknown as typeof fetch,
        requests,
        deliver: (messages: unknown[]) => {
            remoteMessages = messages;
        },
        posted: (fragment: string) =>
            requests.filter((one) => one.method === "POST" && one.url.includes(fragment)),
    };
}

function remoteMessage(seq: number, id: string, payload: unknown): Record<string, unknown> {
    return {
        content: { c: encode(payload), t: "encrypted" },
        createdAt: 1_000,
        id,
        localId: null,
        seq,
        updatedAt: 1_000,
    };
}

let store: ModuleDatabase;
let sync: HappySyncDatabase;

beforeEach(async () => {
    store = moduleDatabase(happySyncMigrations, "happy-session-client");
    await store.ready;
    sync = createHappySyncDatabase();
    await sync.ensureSession(
        store.context,
        {
            agentId: AGENT_ID,
            credentialFingerprint: "fingerprint",
            encryptionKeyBase64: KEY,
            encryptionVariant: "legacy",
            sessionId: SESSION_ID,
        },
        1_000,
    );
});

afterEach(() => {
    store.close();
});

function client(options: {
    operations: HappySessionOperations;
    server: ReturnType<typeof fakeServer>;
    socket: FakeSocket;
}): HappySessionClient {
    return new HappySessionClient({
        agentId: AGENT_ID,
        configuration: CONFIGURATION,
        context: store.context,
        fetch: options.server.fetch,
        operations: options.operations,
        sessionId: SESSION_ID,
        socketFactory: () => options.socket,
        sync,
        version: "1.2.3",
    });
}

describe("keeping one session in step with Happy", () => {
    it("creates the remote session under the tag that identifies it", async () => {
        const server = fakeServer();
        const socket = new FakeSocket();
        const session = client({ operations: fakeOperations().operations, server, socket });
        await session.settle();

        const created = server.posted("/v1/sessions")[0];
        expect(created?.body).toMatchObject({ agentState: null, tag: happySessionTag(SESSION_ID) });
        expect(await sync.readSession(store.context, AGENT_ID)).toMatchObject({
            remoteSessionId: "remote-1",
        });
        await session.close();
    });

    it("creates it once and reuses it afterwards", async () => {
        const server = fakeServer();
        const session = client({
            operations: fakeOperations().operations,
            server,
            socket: new FakeSocket(),
        });
        await session.settle();
        await session.settle();
        expect(server.posted("/v1/sessions")).toHaveLength(1);
        await session.close();
    });

    it("registers everything the phone may ask of it", async () => {
        const socket = new FakeSocket();
        const session = client({
            operations: fakeOperations().operations,
            server: fakeServer(),
            socket,
        });
        await session.settle();
        expect(socket.emittedValues("rpc-register")).toEqual([
            { method: "remote-1:abort" },
            { method: "remote-1:communication" },
            { method: "remote-1:killSession" },
        ]);
        await session.close();
    });

    it("sends what the outbox owes, encrypted, and forgets it once accepted", async () => {
        await sync.projectEvent(store.context, {
            agentId: AGENT_ID,
            eventId: "01900000-0000-7000-8000-000000000001",
            messages: [
                { localId: "rig:m1", payload: { content: { ev: { t: "text", text: "hi" } } } },
            ],
            now: 1_000,
        });
        const server = fakeServer();
        const session = client({
            operations: fakeOperations().operations,
            server,
            socket: new FakeSocket(),
        });
        await session.settle();

        const sent = server.posted("/v3/sessions/remote-1/messages")[0]?.body as {
            messages: { content: string; localId: string }[];
        };
        expect(sent.messages).toHaveLength(1);
        expect(sent.messages[0]?.localId).toBe("rig:m1");
        expect(decode(sent.messages[0]?.content ?? "")).toEqual({
            content: { ev: { t: "text", text: "hi" } },
        });
        expect(await sync.pending(store.context, AGENT_ID, 10)).toEqual([]);
        await session.close();
    });

    it("delivers what the person said on the phone", async () => {
        const server = fakeServer();
        const { calls, operations } = fakeOperations();
        server.deliver([
            remoteMessage(7, "remote-message-1", {
                content: { text: "carry on", type: "text" },
                meta: { model: "gpt-5.6-sol", modelProviderId: "codex", thinkingLevel: "high" },
                role: "user",
            }),
        ]);
        const session = client({ operations, server, socket: new FakeSocket() });
        await session.settle();

        const submitted = calls.find((call) => call.kind === "submit")
            ?.detail as HappyInboundMessage;
        expect(submitted.text).toBe("carry on");
        expect(submitted.remoteMessageId).toBe("happy:remote-message-1");
        expect(submitted.selection).toEqual({
            effort: "high",
            modelId: "gpt-5.6-sol",
            providerId: "codex",
        });
        expect(await sync.readSession(store.context, AGENT_ID)).toMatchObject({ lastRemoteSeq: 7 });
        await session.close();
    });

    it("says nothing to the agent about Happy Agent's own message coming back", async () => {
        const server = fakeServer();
        const { calls, operations } = fakeOperations();
        server.deliver([
            remoteMessage(3, "remote-message-1", {
                content: { text: "mine", type: "text" },
                meta: { sentFrom: "rig" },
                role: "user",
            }),
        ]);
        const session = client({ operations, server, socket: new FakeSocket() });
        await session.settle();
        expect(calls.filter((call) => call.kind === "submit")).toEqual([]);
        expect(await sync.readSession(store.context, AGENT_ID)).toMatchObject({ lastRemoteSeq: 3 });
        await session.close();
    });

    it("answers a message it can never take, and keeps reading the ones behind it", async () => {
        const server = fakeServer();
        const calls: Call[] = [];
        const { operations } = fakeOperations({
            submit: async (_ctx, _agentId, message) => {
                calls.push({ detail: message, kind: "submit" });
                if (message.text === "use a model that is gone") {
                    throw new HappyMessageRefused("That model is not available.");
                }
            },
        });
        server.deliver([
            remoteMessage(4, "remote-message-1", {
                content: { text: "use a model that is gone", type: "text" },
                role: "user",
            }),
            remoteMessage(5, "remote-message-2", {
                content: { text: "and now this one", type: "text" },
                role: "user",
            }),
        ]);
        const session = client({ operations, server, socket: new FakeSocket() });
        await session.settle();

        const said = server
            .posted("/messages")
            .flatMap((request) => (request.body as { messages: { localId: string }[] }).messages);
        expect(said.map((one) => one.localId)).toContain("rig:refused:remote-message-1");
        // The message behind it still ran, and Happy was told to send neither again.
        expect(calls).toHaveLength(2);
        expect(await sync.readSession(store.context, AGENT_ID)).toMatchObject({ lastRemoteSeq: 5 });
        await session.close();
    });

    it("drops a selection naming a permission mode Happy Agent does not have", async () => {
        const server = fakeServer();
        const { calls, operations } = fakeOperations();
        server.deliver([
            remoteMessage(1, "remote-message-1", {
                content: { text: "go", type: "text" },
                meta: { permissionMode: "anything_goes" },
                role: "user",
            }),
        ]);
        const session = client({ operations, server, socket: new FakeSocket() });
        await session.settle();
        const submitted = calls.find((call) => call.kind === "submit")
            ?.detail as HappyInboundMessage;
        expect(submitted.selection.permissionMode).toBeUndefined();
        await session.close();
    });

    it("tells Happy whether the agent is working", async () => {
        const socket = new FakeSocket();
        const { operations, snapshot } = fakeOperations();
        const working = { ...snapshot, working: true };
        const session = client({
            operations: { ...operations, session: async () => working },
            server: fakeServer(),
            socket,
        });
        await session.settle();
        expect(socket.emittedValues("session-alive")[0]).toMatchObject({
            sid: "remote-1",
            thinking: true,
        });
        await session.close();
    });

    it("publishes the session's own facts, encrypted", async () => {
        const socket = new FakeSocket();
        const session = client({
            operations: fakeOperations().operations,
            server: fakeServer(),
            socket,
        });
        await session.settle();
        const published = socket.emittedValues("update-metadata")[0] as {
            expectedVersion: number;
            metadata: string;
        };
        expect(published.expectedVersion).toBe(4);
        expect(decode(published.metadata)).toMatchObject({
            client: { id: "rig", name: "Happy Agent", version: "1.2.3" },
            currentModelCode: "gpt-5.6-sol",
        });
        await session.close();
    });

    it("does not republish facts that have not changed", async () => {
        const socket = new FakeSocket();
        const session = client({
            operations: fakeOperations().operations,
            server: fakeServer(),
            socket,
        });
        await session.settle();
        await session.settle();
        expect(socket.emittedValues("update-metadata")).toHaveLength(1);
        await session.close();
    });

    it("republishes metadata only when the latest meaningful-message timestamp changes", async () => {
        const socket = new FakeSocket();
        const { operations, snapshot } = fakeOperations();
        let lastMeaningfulMessageAt = 1_000;
        const session = client({
            operations: {
                ...operations,
                session: async () => ({ ...snapshot, lastMeaningfulMessageAt }),
            },
            server: fakeServer(),
            socket,
        });
        await session.settle();
        await session.settle();
        expect(socket.emittedValues("update-metadata")).toHaveLength(1);

        lastMeaningfulMessageAt = 2_000;
        await session.settle();
        const updates = socket.emittedValues("update-metadata") as { metadata: string }[];
        expect(updates).toHaveLength(2);
        expect(decode(updates[1]!.metadata)).toMatchObject({
            lastMeaningfulMessageAt: 2_000,
        });
        await session.close();
    });

    it("republishes Git line counts and clears them when comparison becomes unavailable", async () => {
        const socket = new FakeSocket();
        const { operations, snapshot } = fakeOperations();
        let git: HappySessionSnapshot["git"] = {
            changedFiles: 2,
            countsExact: true,
            deletions: 4,
            insertions: 12,
        };
        const session = client({
            operations: {
                ...operations,
                session: async () => ({ ...snapshot, ...(git === undefined ? {} : { git }) }),
            },
            server: fakeServer(),
            socket,
        });
        await session.settle();
        expect(
            decode((socket.emittedValues("update-metadata")[0] as { metadata: string }).metadata),
        ).toMatchObject({ git });

        git = undefined;
        await session.settle();
        const updates = socket.emittedValues("update-metadata") as { metadata: string }[];
        expect(updates).toHaveLength(2);
        expect(decode(updates[1]!.metadata)).not.toHaveProperty("git");
        await session.close();
    });

    it("puts Happy Agent's facts back on top of whatever was written first", async () => {
        const socket = new FakeSocket();
        socket.acknowledgements = [
            { metadata: encode({ theirs: "kept" }), result: "version-mismatch", version: 9 },
            { result: "success", version: 10 },
        ];
        const session = client({
            operations: fakeOperations().operations,
            server: fakeServer(),
            socket,
        });
        await session.settle();
        const attempts = socket.emittedValues("update-metadata") as { metadata: string }[];
        expect(attempts).toHaveLength(2);
        expect(decode(attempts[1]?.metadata ?? "")).toMatchObject({
            currentModelCode: "gpt-5.6-sol",
            theirs: "kept",
        });
        await session.close();
    });

    it("publishes a question the session is waiting on", async () => {
        const socket = new FakeSocket();
        const { operations, pending } = fakeOperations();
        pending.push({
            askingAgentId: AGENT_ID,
            context: "Deciding.",
            createdAt: 1_000,
            id: "req-1",
            question: "Which way?",
            status: "pending",
            updatedAt: 1_000,
        } as UserInputRequest);
        const session = client({ operations, server: fakeServer(), socket });
        await session.settle();
        const published = socket.emittedValues("update-state")[0] as { agentState: string };
        expect(decode(published.agentState)).toMatchObject({
            communications: { "req-1": { kind: "form", toolUseId: "req-1" } },
        });
        await session.close();
    });

    it("says nothing about questions when there are none", async () => {
        const socket = new FakeSocket();
        const session = client({
            operations: fakeOperations().operations,
            server: fakeServer(),
            socket,
        });
        await session.settle();
        expect(socket.emittedValues("update-state")).toEqual([]);
        await session.close();
    });
});

describe("answering what the phone asks of a session", () => {
    it("stops the agent", async () => {
        const socket = new FakeSocket();
        const { calls, operations } = fakeOperations();
        const session = client({ operations, server: fakeServer(), socket });
        await session.settle();
        expect(await socket.rpc("remote-1:abort", {})).toEqual({ success: true });
        expect(calls.some((call) => call.kind === "abort")).toBe(true);
        await session.close();
    });

    it("ends the session for the kill switch", async () => {
        const socket = new FakeSocket();
        const { calls, operations } = fakeOperations();
        const session = client({ operations, server: fakeServer(), socket });
        await session.settle();
        expect(await socket.rpc("remote-1:killSession", {})).toEqual({ success: true });
        expect(calls.find((call) => call.kind === "archive")?.detail).toBe(SESSION_ID);
        await session.close();
    });

    it("records an answer to a question it is actually waiting on", async () => {
        const socket = new FakeSocket();
        const { calls, operations, pending } = fakeOperations();
        pending.push({
            askingAgentId: AGENT_ID,
            context: "Deciding.",
            createdAt: 1_000,
            id: "req-1",
            question: "Which way?",
            status: "pending",
            updatedAt: 1_000,
        } as UserInputRequest);
        const session = client({ operations, server: fakeServer(), socket });
        await session.settle();
        await socket.rpc("remote-1:communication", {
            answers: { "req-1": { custom: "left" } },
            id: "req-1",
            status: "answered",
        });
        expect(calls.find((call) => call.kind === "answer")?.detail).toEqual({
            answers: { "req-1": { custom: "left" } },
            requestId: "req-1",
        });
        await session.close();
    });

    it("ignores an answer to a question nobody is asking", async () => {
        const socket = new FakeSocket();
        const { calls, operations } = fakeOperations();
        const session = client({ operations, server: fakeServer(), socket });
        await session.settle();
        await socket.rpc("remote-1:communication", {
            answers: {},
            id: "req-gone",
            status: "answered",
        });
        expect(calls.filter((call) => call.kind === "answer")).toEqual([]);
        await session.close();
    });

    it("refuses a request addressed to another session", async () => {
        const socket = new FakeSocket();
        const { calls, operations } = fakeOperations();
        const session = client({ operations, server: fakeServer(), socket });
        await session.settle();
        expect(await socket.rpc("remote-2:abort", {})).toEqual({ error: "Invalid request" });
        expect(calls.filter((call) => call.kind === "abort")).toEqual([]);
        await session.close();
    });
});

describe("ending a session", () => {
    it("tells Happy the session is over and archives it", async () => {
        const socket = new FakeSocket();
        const server = fakeServer();
        const session = client({ operations: fakeOperations().operations, server, socket });
        await session.settle();
        await session.archive();
        expect(socket.emittedValues("session-end")[0]).toMatchObject({ sid: "remote-1" });
        expect(server.posted("/v1/sessions/remote-1/archive")).toHaveLength(1);
    });

    it("ends in Happy Agent even when Happy refuses the archive", async () => {
        const socket = new FakeSocket();
        const server = fakeServer();
        const failing = {
            ...server,
            fetch: (async (input: string | URL, init: RequestInit = {}) => {
                const url = typeof input === "string" ? input : input.toString();
                if (url.endsWith("/archive")) return new Response("no", { status: 500 });
                return await (server.fetch as unknown as typeof fetch)(input, init);
            }) as unknown as typeof fetch,
        };
        const session = client({
            operations: fakeOperations().operations,
            server: failing,
            socket,
        });
        await session.settle();
        await expect(session.archive()).resolves.toBeUndefined();
    });

    it("stops answering the phone once the session has ended", async () => {
        const socket = new FakeSocket();
        const { calls, operations } = fakeOperations();
        const session = client({ operations, server: fakeServer(), socket });
        await session.settle();
        const archiving = session.archive();
        const answer = await socket.rpc("remote-1:abort", {});
        await archiving;
        expect(answer).toEqual({ error: "This session has ended." });
        expect(calls.filter((call) => call.kind === "abort")).toEqual([]);
    });
});
