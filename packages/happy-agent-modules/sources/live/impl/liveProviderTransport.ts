import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// Public Live docs and native Codex 4dd51f4a5f2037f8aa322fe7807315e6530a4ec8
// are distinct dialects. Never substitute endpoints or credentials on failure.
const Text = Type.String({ maxLength: 65536 });
const Id = Type.String({ minLength: 1, maxLength: 512, pattern: "^[A-Za-z0-9_-]+$" });
const Seconds = Type.Number({ minimum: 0 });
const Timestamp = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Role = Type.Union([Type.Literal("user"), Type.Literal("assistant")]);
const FailureCode = Type.Union([
    Type.Literal("forbidden"),
    Type.Literal("unsupported"),
    Type.Literal("live_unavailable"),
]);
const Credential = Type.Object(
    {
        type: Type.Union([Type.Literal("openai_api_key"), Type.Literal("codex_subscription")]),
        token: Type.String({ minLength: 1, maxLength: 32768 }),
        accountId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    },
    { additionalProperties: false },
);
const Input = Type.Object(
    {
        credential: Credential,
        sdp: Type.String({ minLength: 1, maxLength: 65536 }),
        instructions: Type.String({ minLength: 1, maxLength: 65536 }),
    },
    { additionalProperties: false },
);
const Append = Type.Object(
    {
        delegationId: Type.Union([Id, Type.Null()]),
        text: Type.String({ minLength: 1, maxLength: 65536 }),
        speakable: Type.Boolean(),
    },
    { additionalProperties: false },
);

const transportStateSchema = Type.Union([
    Type.Object({
        phase: Type.Union([
            Type.Literal("connecting"),
            Type.Literal("starting"),
            Type.Literal("active"),
            Type.Literal("ended"),
        ]),
    }),
    Type.Object({ phase: Type.Literal("closing"), wasReady: Type.Boolean() }),
]);
type TransportState = Static<typeof transportStateSchema>;

export const LiveProviderEventSchema = Type.Union([
    Type.Object({ type: Type.Literal("ready") }, { additionalProperties: false }),
    Type.Object(
        { type: Type.Literal("transcript"), role: Role, text: Text },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("transcript"),
            role: Role,
            text: Text,
            startMs: Timestamp,
            endMs: Timestamp,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        { type: Type.Literal("delegation"), delegationId: Id, text: Type.Optional(Text) },
        { additionalProperties: false },
    ),
    Type.Object(
        { type: Type.Literal("usage"), seconds: Seconds, final: Type.Boolean() },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("ended"),
            orderly: Type.Boolean(),
            error: Type.Union([Type.String({ maxLength: 256 }), Type.Null()]),
            code: Type.Optional(FailureCode),
        },
        { additionalProperties: false },
    ),
]);
export type LiveProviderEvent = Static<typeof LiveProviderEventSchema>;
export type LiveProviderOptions = Static<typeof Input> & {
    signal: AbortSignal;
    onEvent(event: LiveProviderEvent): void;
};
export type LiveProviderTransport = {
    sdp: string;
    close(): Promise<void>;
    append(input: Static<typeof Append>): Promise<void>;
    dispose(): void;
};

export class LiveProviderError extends Error {
    readonly status: 403 | 501 | 503;
    readonly code: Static<typeof FailureCode>;
    constructor(
        code: Static<typeof FailureCode> = "live_unavailable",
        reason?: "readiness_timeout" | "setup_timeout" | "close_timeout" | "sign_in" | "api_key",
    ) {
        super(
            reason === "sign_in"
                ? "The selected sign-in expired or was rejected. Sign in to Codex again."
                : reason === "api_key"
                  ? "The selected OpenAI API key was rejected. Check the selected account's API key."
                  : reason === "readiness_timeout"
                    ? "GPT-Live did not become ready before the startup deadline."
                    : reason === "setup_timeout"
                      ? "GPT-Live connection setup exceeded its deadline."
                      : reason === "close_timeout"
                        ? "GPT-Live did not confirm closure before the deadline."
                        : code === "forbidden"
                          ? "The selected provider denied access to GPT-Live."
                          : code === "unsupported"
                            ? "GPT-Live is not supported by the selected provider."
                            : "The GPT-Live connection is unavailable.",
        );
        this.name = "LiveProviderError";
        this.code = code;
        this.status = code === "forbidden" ? 403 : code === "unsupported" ? 501 : 503;
    }
}

// Dependency seams are internal, trusted code only; they do not accept caller URLs.
export type LiveProviderDependencies = {
    fetch: typeof fetch;
    connect(url: string, headers: Record<string, string>): WebSocket;
    setupTimeoutMs: number;
    readyTimeoutMs: number;
    closeTimeoutMs: number;
};
const defaults: LiveProviderDependencies = {
    fetch: globalThis.fetch,
    connect: (url, headers) =>
        new WebSocket(url, {
            headers,
            followRedirects: false,
            handshakeTimeout: 30000,
            maxPayload: 1024 * 1024,
        }),
    setupTimeoutMs: 30000,
    readyTimeoutMs: 30000,
    closeTimeoutMs: 15000,
};

const Envelope = Type.Object({ type: Type.String({ minLength: 1, maxLength: 128 }) });
const Session = Type.Object({ id: Id });
const Ready = Type.Object({
    type: Type.Union([Type.Literal("session.started"), Type.Literal("session.updated")]),
    session: Session,
});
const PublicAnswer = Type.Object({
    session: Session,
    transport: Type.Object({
        type: Type.Literal("webrtc"),
        sdp: Type.String({ minLength: 1, maxLength: 65536 }),
    }),
});
const PublicTranscript = Type.Object({
    type: Type.String(),
    delta: Text,
    start_ms: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    end_ms: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});
const NativeTranscript = Type.Object({
    type: Type.String(),
    item: Type.Object({
        id: Id,
        type: Type.Union([Type.Literal("input_transcript"), Type.Literal("output_transcript")]),
        text: Text,
    }),
});
const PublicDelegation = Type.Object({
    type: Type.String(),
    delegation: Type.Object({
        id: Id,
        type: Type.Literal("delegation"),
        target: Type.Literal("client"),
    }),
});
const NativeDelegation = Type.Object({
    type: Type.String(),
    item: Type.Object({
        id: Id,
        type: Type.Literal("delegation"),
        target: Type.Literal("client"),
        content: Type.Array(Type.Object({ type: Type.Literal("input_text"), text: Text }), {
            maxItems: 128,
        }),
    }),
});
const Usage = Type.Object({ type: Type.String(), usage: Type.Object({ seconds: Seconds }) });
const Closed = Type.Object({
    type: Type.Literal("session.closed"),
    session: Session,
    usage: Type.Object({ seconds: Seconds }),
    reason: Type.Union(
        ["close_requested", "expired", "content", "remote_hangup", "connection_lost"].map((value) =>
            Type.Literal(value),
        ),
    ),
});
const ProviderError = Type.Object({
    type: Type.Literal("error"),
    error: Type.Optional(Type.Object({ code: Type.Optional(Type.String({ maxLength: 128 })) })),
    code: Type.Optional(Type.String({ maxLength: 128 })),
});

function chunks(text: string): string[] {
    // Native limit is 500 UTF-8 bytes. Public limit is 500 tokens; 500 bytes
    // is a conservative bound even with byte-fallback tokenization.
    const parts: string[] = [];
    let part = "",
        bytes = 0;
    for (const character of text) {
        const size = Buffer.byteLength(character, "utf8");
        if (bytes + size > 500) {
            parts.push(part);
            part = "";
            bytes = 0;
        }
        part += character;
        bytes += size;
    }
    if (part) parts.push(part);
    return parts;
}

async function boundedBody(response: Response): Promise<string> {
    if (!response.body) throw new LiveProviderError();
    const reader = response.body.getReader();
    const result: Uint8Array[] = [];
    let bytes = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 131072) throw new LiveProviderError();
            result.push(value);
        }
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
    return Buffer.concat(result).toString("utf8");
}

export async function createLiveProviderTransport(
    options: LiveProviderOptions,
    dependencies: LiveProviderDependencies = defaults,
): Promise<LiveProviderTransport> {
    const setupDeadline = Date.now() + dependencies.setupTimeoutMs;
    const { credential, sdp, instructions, signal, onEvent } = options;
    if (
        !Value.Check(Input, { credential, sdp, instructions }) ||
        !(signal instanceof AbortSignal) ||
        typeof onEvent !== "function" ||
        signal.aborted
    )
        throw new LiveProviderError();
    const native = credential.type === "codex_subscription";
    const headers: Record<string, string> = {
        Authorization: `Bearer ${credential.token}`,
        "User-Agent": "happy-agent-live/1",
    };
    if (native)
        Object.assign(headers, {
            ...(credential.accountId ? { "ChatGPT-Account-ID": credential.accountId } : {}),
            "OpenAI-Alpha": "quicksilver=v2",
            "x-session-id": randomUUID(),
            "session-id": randomUUID(),
            "thread-id": randomUUID(),
            originator: "happy_agent",
        });
    const session = {
        model: native ? "gpt-live-1-codex" : "gpt-live-1",
        instructions,
        audio: { output: { voice: "marin" } },
        delegation: { type: "client" },
    };
    let answer: string, sessionId: string;
    try {
        const response = await dependencies.fetch(
            native
                ? "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas"
                : "https://api.openai.com/v1/live/sessions",
            {
                method: "POST",
                redirect: "error",
                headers: { ...headers, "Content-Type": "application/json" },
                body: JSON.stringify(
                    native ? { sdp, session } : { session, transport: { type: "webrtc", sdp } },
                ),
                signal: AbortSignal.any([
                    signal,
                    AbortSignal.timeout(Math.max(1, setupDeadline - Date.now())),
                ]),
            },
        );
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new LiveProviderError(
                response.status === 401 || response.status === 403
                    ? "forbidden"
                    : response.status === 404 || response.status === 501
                      ? "unsupported"
                      : "live_unavailable",
                response.status === 401 ? (native ? "sign_in" : "api_key") : undefined,
            );
        }
        const text = await boundedBody(response);
        if (native) {
            const location = response.headers.get("location");
            if (
                !location ||
                location.length > 2048 ||
                !text.trim() ||
                Buffer.byteLength(text) > 65536
            )
                throw new LiveProviderError();
            const path = new URL(location, "https://chatgpt.com").pathname;
            const callId = path
                .split("/")
                .find((part) =>
                    /^(rtc_[\w-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(
                        part,
                    ),
                );
            if (!callId || !Value.Check(Id, callId)) throw new LiveProviderError();
            sessionId = callId;
            answer = text;
        } else {
            const value: unknown = JSON.parse(text);
            if (!Value.Check(PublicAnswer, value)) throw new LiveProviderError();
            sessionId = value.session.id;
            answer = value.transport.sdp;
        }
    } catch (error) {
        throw error instanceof LiveProviderError ? error : new LiveProviderError();
    }

    let socket: WebSocket;
    try {
        socket = dependencies.connect(
            native
                ? `wss://api.openai.com/v1/live/${encodeURIComponent(sessionId)}`
                : `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`,
            headers,
        );
    } catch {
        throw new LiveProviderError();
    }
    let state: TransportState = { phase: "connecting" };
    let setupTimer: ReturnType<typeof setTimeout> | undefined;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveAttached!: () => void, rejectAttached!: (error: LiveProviderError) => void;
    const attached = new Promise<void>((resolve, reject) => {
        resolveAttached = resolve;
        rejectAttached = reject;
    });
    let resolveEnd!: () => void;
    const terminal = new Promise<void>((resolve) => {
        resolveEnd = resolve;
    });
    let queuedBytes = 0,
        queuedOperations = 0;
    let queue: Promise<void> = Promise.resolve();
    const transcriptItems = new Set<string>();

    const emit = (event: LiveProviderEvent) => {
        if (!Value.Check(LiveProviderEventSchema, event)) throw new LiveProviderError();
        try {
            onEvent(event);
        } catch {
            finish(false, new LiveProviderError());
        }
    };
    const finish = (orderly: boolean, error?: LiveProviderError) => {
        if (state.phase === "ended") return;
        state = { phase: "ended" };
        clearTimeout(setupTimer);
        clearTimeout(readyTimer);
        clearTimeout(closeTimer);
        signal.removeEventListener("abort", abort);
        rejectAttached(error ?? new LiveProviderError());
        socket.terminate();
        resolveEnd();
        emit({
            type: "ended",
            orderly,
            error: error?.message ?? null,
            ...(error ? { code: error.code } : {}),
        });
    };
    const send = (value: unknown): Promise<void> =>
        new Promise((resolve, reject) => {
            if (
                state.phase === "ended" ||
                socket.readyState !== WebSocket.OPEN ||
                socket.bufferedAmount > 262144
            ) {
                reject(new LiveProviderError());
                return;
            }
            try {
                socket.send(JSON.stringify(value), (error) =>
                    error ? reject(new LiveProviderError()) : resolve(),
                );
            } catch {
                reject(new LiveProviderError());
            }
        });
    const close = (): Promise<void> => {
        if (state.phase === "ended" || state.phase === "closing") return terminal;
        state = { phase: "closing", wasReady: state.phase === "active" };
        clearTimeout(readyTimer);
        closeTimer = setTimeout(
            () => finish(false, new LiveProviderError("live_unavailable", "close_timeout")),
            dependencies.closeTimeoutMs,
        );
        if (socket.readyState === WebSocket.OPEN)
            void send({ type: "session.close" })
                .then(() => {
                    if (native && state.phase !== "ended") socket.close(1000);
                })
                .catch(() => finish(false, new LiveProviderError()));
        else finish(false, new LiveProviderError());
        return terminal;
    };
    const abort = () => {
        void close();
    };
    signal.addEventListener("abort", abort, { once: true });
    setupTimer = setTimeout(
        () => finish(false, new LiveProviderError("live_unavailable", "setup_timeout")),
        Math.max(0, setupDeadline - Date.now()),
    );
    socket.on("open", () => {
        if (state.phase === "ended") return;
        if (state.phase === "connecting") state = { phase: "starting" };
        clearTimeout(setupTimer);
        if (signal.aborted) {
            void close();
            return;
        }
        readyTimer = setTimeout(() => {
            if (socket.readyState === WebSocket.OPEN) {
                try {
                    socket.send(JSON.stringify({ type: "session.close" }), () => undefined);
                } catch {}
            }
            finish(false, new LiveProviderError("live_unavailable", "readiness_timeout"));
        }, dependencies.readyTimeoutMs);
        resolveAttached();
    });
    socket.on("unexpected-response", (_request, response) => {
        response.resume();
        finish(
            false,
            new LiveProviderError(
                response.statusCode === 401 || response.statusCode === 403
                    ? "forbidden"
                    : "live_unavailable",
            ),
        );
    });
    socket.on("error", () => finish(false, new LiveProviderError()));
    socket.on("close", (code) => {
        if (state.phase === "ended") return;
        if (native && state.phase === "closing" && state.wasReady && code === 1000) finish(true);
        else finish(false, new LiveProviderError());
    });
    socket.on("message", (data, binary) => {
        if (state.phase === "ended") return;
        if (binary) {
            finish(false, new LiveProviderError());
            return;
        }
        let value: unknown;
        try {
            value = JSON.parse(data.toString());
        } catch {
            finish(false, new LiveProviderError());
            return;
        }
        if (!Value.Check(Envelope, value)) {
            finish(false, new LiveProviderError());
            return;
        }
        const type = value.type;
        if (type === "error") {
            const code = Value.Check(ProviderError, value)
                ? (value.error?.code ?? value.code)
                : undefined;
            finish(
                false,
                new LiveProviderError(
                    code === "forbidden" ||
                        code === "invalid_api_key" ||
                        code === "insufficient_scope"
                        ? "forbidden"
                        : "live_unavailable",
                ),
            );
            return;
        }
        if (type === "session.started" || (native && type === "session.updated")) {
            if (!Value.Check(Ready, value) || (!native && value.session.id !== sessionId)) {
                finish(false, new LiveProviderError());
                return;
            }
            if (state.phase === "starting") {
                state = { phase: "active" };
                clearTimeout(readyTimer);
                emit({ type: "ready" });
            }
            return;
        }
        if (!native && type === "session.closed") {
            if (!Value.Check(Closed, value) || value.session.id !== sessionId) {
                finish(false, new LiveProviderError());
                return;
            }
            emit({ type: "usage", seconds: value.usage.seconds, final: true });
            const orderly =
                state.phase === "closing" && state.wasReady && value.reason === "close_requested";
            finish(orderly, orderly ? undefined : new LiveProviderError());
            return;
        }
        if (!native && type === "session.usage.updated") {
            if (!Value.Check(Usage, value)) {
                finish(false, new LiveProviderError());
                return;
            }
            emit({ type: "usage", seconds: value.usage.seconds, final: false });
            return;
        }
        if (state.phase === "closing") return;
        if (
            !native &&
            (type === "session.input_transcript.delta" ||
                type === "session.output_transcript.delta")
        ) {
            if (
                state.phase !== "active" ||
                !Value.Check(PublicTranscript, value) ||
                value.end_ms < value.start_ms
            ) {
                finish(false, new LiveProviderError());
                return;
            }
            emit({
                type: "transcript",
                role: type.includes("input_") ? "user" : "assistant",
                text: value.delta,
                ...(Number.isInteger(value.start_ms) && Number.isInteger(value.end_ms)
                    ? { startMs: value.start_ms, endMs: value.end_ms }
                    : {}),
            });
            return;
        }
        if (native && (type === "input_transcript.added" || type === "output_transcript.added")) {
            if (
                state.phase !== "active" ||
                !Value.Check(NativeTranscript, value) ||
                value.item.type !==
                    (type.startsWith("input_") ? "input_transcript" : "output_transcript")
            ) {
                finish(false, new LiveProviderError());
                return;
            }
            const key = `${value.item.type}:${value.item.id}`;
            if (transcriptItems.has(key)) return;
            // Display-only deduplication must not put a lifetime limit on conversation length.
            if (transcriptItems.size >= 512)
                transcriptItems.delete(transcriptItems.values().next().value!);
            transcriptItems.add(key);
            emit({
                type: "transcript",
                role: type.startsWith("input_") ? "user" : "assistant",
                text: value.item.text,
            });
            return;
        }
        if (!native && type === "session.delegation.created") {
            if (state.phase !== "active" || !Value.Check(PublicDelegation, value)) {
                finish(false, new LiveProviderError());
                return;
            }
            emit({ type: "delegation", delegationId: value.delegation.id });
            return;
        }
        if (native && type === "delegation.created") {
            if (state.phase !== "active" || !Value.Check(NativeDelegation, value)) {
                finish(false, new LiveProviderError());
                return;
            }
            const text = value.item.content.map((item) => item.text).join("");
            if (text.length > 65536) {
                finish(false, new LiveProviderError());
                return;
            }
            emit({ type: "delegation", delegationId: value.item.id, text });
        }
        // Native turn.done aggregates already-emitted fragments; it is deliberately ignored.
    });
    if (signal.aborted) abort();
    await attached;
    return {
        sdp: answer,
        close,
        dispose: () => finish(false, new LiveProviderError()),
        append: (input) => {
            if (!Value.Check(Append, input) || state.phase !== "active")
                return Promise.reject(new LiveProviderError());
            const { delegationId, text, speakable } = input;
            const bytes = Buffer.byteLength(text);
            if (queuedOperations >= 128 || queuedBytes + bytes > 262144)
                return Promise.reject(new LiveProviderError());
            queuedBytes += bytes;
            queuedOperations++;
            const operation = queue.then(async () => {
                for (const content of chunks(text)) {
                    if (state.phase !== "active") throw new LiveProviderError();
                    await send(
                        native
                            ? {
                                  type:
                                      delegationId === null
                                          ? "session.context.append"
                                          : "delegation.context.append",
                                  ...(delegationId === null
                                      ? {}
                                      : { delegation_item_id: delegationId }),
                                  channel: speakable ? "speakable" : "commentary",
                                  content: [{ type: "input_text", text: content }],
                              }
                            : {
                                  type: speakable
                                      ? "session.commentary.append"
                                      : "session.thinking.append",
                                  event_id: randomUUID(),
                                  delegation_id: delegationId,
                                  content,
                              },
                    );
                }
            });
            queue = operation
                .catch(() => undefined)
                .finally(() => {
                    queuedBytes -= bytes;
                    queuedOperations--;
                });
            return operation;
        },
    };
}
