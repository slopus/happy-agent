import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { PushDeliveryOutcome } from "../PushNotification.js";

/** Happy's push relay. Capabilities are sent nowhere else. */
export const PUSH_RELAY_SEND_URL = "https://push.cluster-fluster.com/v1/push/send";
const SEND_TIMEOUT_MS = 8_000;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;

const ticketSchema = Type.Union([
    Type.Object({ status: Type.Literal("ok"), id: Type.String() }),
    Type.Object({
        status: Type.Literal("error"),
        details: Type.Optional(
            Type.Union([
                Type.Null(),
                Type.Object({ error: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
            ]),
        ),
    }),
]);
const envelopeSchema = Type.Object({ data: Type.Array(ticketSchema) });

const UNKNOWN: PushDeliveryOutcome = { kind: "unknown" };

/**
 * Send one relay request for one phone and say what became of it. One attempt: no redirect is
 * followed, the whole exchange has eight seconds, and at most 16 KiB of the answer is read.
 * Anything short of a clear answer is `unknown`, because the relay may already have delivered it.
 * Nothing from the relay's own text is returned or thrown, since it may echo the token.
 */
export async function pushRelaySend(
    message: Record<string, unknown>,
    lifetime: AbortSignal | undefined,
): Promise<PushDeliveryOutcome> {
    const body = JSON.stringify(message);
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
        return { kind: "rejected", reason: "message_too_big" };
    }
    const timeout = AbortSignal.timeout(SEND_TIMEOUT_MS);
    try {
        const response = await fetch(PUSH_RELAY_SEND_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            redirect: "manual",
            signal: lifetime === undefined ? timeout : AbortSignal.any([timeout, lifetime]),
        });
        if (response.status === 429 || response.status === 408 || response.status >= 500) {
            return UNKNOWN;
        }
        if (response.status >= 300 && response.status < 400) {
            return { kind: "rejected", reason: "redirect_refused" };
        }
        if (response.status !== 200) return { kind: "rejected", reason: "request_rejected" };
        const text = await readBounded(response);
        return text === undefined ? UNKNOWN : ticketOutcome(text);
    } catch {
        return UNKNOWN;
    }
}

/** The answer's text, or `undefined` once it runs past the bound. */
async function readBounded(response: Response): Promise<string | undefined> {
    if (response.body === null) return "";
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) return undefined;
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function ticketOutcome(text: string): PushDeliveryOutcome {
    let envelope: unknown;
    try {
        envelope = JSON.parse(text);
    } catch {
        return UNKNOWN;
    }
    // One request is one phone. A registration is never removed on an ambiguous batch answer.
    if (!Value.Check(envelopeSchema, envelope) || envelope.data.length !== 1) return UNKNOWN;
    const ticket = envelope.data[0]!;
    if (ticket.status === "ok") return ticket.id === "" ? UNKNOWN : { kind: "accepted" };
    switch (ticket.details?.error) {
        case "DeviceNotRegistered":
            return { kind: "unregistered" };
        case "InvalidCredentials":
            return { kind: "rejected", reason: "invalid_credentials" };
        case "MessageTooBig":
            return { kind: "rejected", reason: "message_too_big" };
        case "MismatchSenderId":
            return { kind: "rejected", reason: "mismatch_sender_id" };
        default:
            return UNKNOWN;
    }
}
