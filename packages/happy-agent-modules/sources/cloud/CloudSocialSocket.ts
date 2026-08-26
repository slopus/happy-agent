import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import WebSocket, { type RawData } from "ws";

import { cloudVersionSchema } from "./CloudDatabase.js";

const CLOUD_SOCKET_HANDSHAKE_TIMEOUT_MS = 15_000;
const MAX_CLOUD_SOCKET_MESSAGE_BYTES = 256 * 1_024;
const exact = { additionalProperties: false } as const;

const friendEntrySchema = Type.Object(
    {
        firstName: Type.String({
            minLength: 1,
            maxLength: 64,
            pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
        }),
        lastName: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 64,
                pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
            }),
        ),
        username: Type.String({ minLength: 3, maxLength: 24, pattern: "^[a-z0-9_]+$" }),
    },
    exact,
);

const publicProfileSchema = Type.Object(
    {
        ...friendEntrySchema.properties,
        version: cloudVersionSchema,
    },
    exact,
);

export const cloudSocialUpdateSchema = Type.Union([
    Type.Object({ kind: Type.Literal("blocked-added"), user: friendEntrySchema }, exact),
    Type.Object(
        {
            kind: Type.Literal("blocked-removed"),
            username: friendEntrySchema.properties.username,
        },
        exact,
    ),
    Type.Object({ kind: Type.Literal("friend-added"), user: friendEntrySchema }, exact),
    Type.Object(
        {
            kind: Type.Literal("friend-removed"),
            username: friendEntrySchema.properties.username,
        },
        exact,
    ),
    Type.Object({ kind: Type.Literal("profile-updated"), profile: publicProfileSchema }, exact),
    Type.Object({ kind: Type.Literal("request-incoming-added"), user: friendEntrySchema }, exact),
    Type.Object(
        {
            kind: Type.Literal("request-incoming-removed"),
            username: friendEntrySchema.properties.username,
        },
        exact,
    ),
    Type.Object({ kind: Type.Literal("request-outgoing-added"), user: friendEntrySchema }, exact),
    Type.Object(
        {
            kind: Type.Literal("request-outgoing-removed"),
            username: friendEntrySchema.properties.username,
        },
        exact,
    ),
]);
export type CloudSocialUpdate = Static<typeof cloudSocialUpdateSchema>;

const cloudSocialStateMessageSchema = Type.Object(
    { type: Type.Literal("state"), version: cloudVersionSchema },
    exact,
);

const cloudSocialUpdateMessageSchema = Type.Object(
    {
        type: Type.Literal("update"),
        updates: Type.Array(cloudSocialUpdateSchema, { maxItems: 64 }),
        version: cloudVersionSchema,
    },
    exact,
);

export interface CloudSocialSocketCallbacks {
    readonly onState: (version: string) => void | Promise<void>;
    readonly onUpdate: (
        version: string,
        updates: readonly CloudSocialUpdate[],
    ) => void | Promise<void>;
}

export interface CloudSocialSocketConnection {
    readonly done: Promise<void>;
    close(): void;
}

/** Opens one authenticated Happy Cloud socket and validates every frame before dispatch. */
export async function openCloudSocialSocket(
    url: string,
    accessToken: string,
    signal: AbortSignal,
    callbacks: CloudSocialSocketCallbacks,
): Promise<CloudSocialSocketConnection> {
    const socket = new WebSocket(url, {
        followRedirects: false,
        handshakeTimeout: CLOUD_SOCKET_HANDSHAKE_TIMEOUT_MS,
        headers: { authorization: `Bearer ${accessToken}` },
        maxPayload: MAX_CLOUD_SOCKET_MESSAGE_BYTES,
        perMessageDeflate: false,
    });
    let receivedState = false;
    let settleReady: (() => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
        settleReady = resolve;
        rejectReady = reject;
    });
    let settleDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
        settleDone = resolve;
    });
    let messageChain = Promise.resolve();
    const fail = (): void => {
        const error = new Error("The Cloud social socket closed before its initial state.");
        rejectReady?.(error);
        rejectReady = undefined;
        try {
            socket.close(1002);
        } catch {}
    };
    const abort = (): void => {
        socket.terminate();
    };

    socket.on("message", (data, isBinary) => {
        messageChain = messageChain
            .then(async () => {
                if (isBinary) throw new Error("The Cloud social socket sent a binary frame.");
                const value = parseMessage(data);
                if (Value.Check(cloudSocialStateMessageSchema, value)) {
                    if (receivedState) {
                        throw new Error("The Cloud social socket repeated its initial state.");
                    }
                    receivedState = true;
                    await callbacks.onState(value.version);
                    settleReady?.();
                    settleReady = undefined;
                    rejectReady = undefined;
                    return;
                }
                if (!receivedState || !Value.Check(cloudSocialUpdateMessageSchema, value)) {
                    throw new Error("The Cloud social socket sent an invalid update.");
                }
                await callbacks.onUpdate(value.version, value.updates);
            })
            .catch(() => {
                fail();
            });
    });
    socket.once("error", () => {
        if (!receivedState) fail();
    });
    socket.once("close", () => {
        if (!receivedState) fail();
        settleDone?.();
        settleDone = undefined;
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();

    try {
        await ready;
    } catch {
        signal.removeEventListener("abort", abort);
        throw new Error("The Cloud social socket is unavailable.");
    }

    return {
        close: () => socket.close(1000),
        done: done.finally(() => {
            signal.removeEventListener("abort", abort);
        }),
    };
}

function parseMessage(data: RawData): unknown {
    const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.byteLength > MAX_CLOUD_SOCKET_MESSAGE_BYTES) {
        throw new Error("The Cloud social socket message is too large.");
    }
    return JSON.parse(bytes.toString("utf8")) as unknown;
}
