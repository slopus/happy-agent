import { Type, type Static } from "@sinclair/typebox";

/**
 * The shapes Happy speaks on the wire.
 *
 * Outbound envelopes are plain interfaces: Happy Agent builds them, so there is nothing
 * to validate. Anything arriving from the server or the phone carries a schema,
 * because it arrives as JSON that Happy Agent did not write.
 */

/** Token counts as Happy names them. */
export interface HappyUsage {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    context_window?: number;
    input_tokens: number;
    output_tokens: number;
    service_tier?: string;
}

/** One thing that happened, as the phone renders it. */
export type HappySessionEvent =
    | { t: "file"; ref: string; name: string; size: number; mimeType?: string }
    // A failure travels as a `service` line. The phone's vocabulary has no failure of its own and
    // silently drops any event it cannot name, so plain words about what went wrong reach a person
    // and a truer-looking event does not.
    | { t: "service"; text: string }
    | { t: "text"; text: string; thinking?: boolean }
    | { t: "tool-call-end"; call: string; result?: string; isError?: boolean }
    | {
          t: "tool-call-start";
          args: Record<string, unknown>;
          call: string;
          description: string;
          name: string;
          title: string;
      }
    | {
          t: "turn-end";
          status: "cancelled" | "completed" | "failed";
          elapsedMs: number;
          reason?: "abort" | "completed" | "error" | "steering";
          turnElapsedMs: number;
      }
    | { t: "turn-start" };

/** One rendered moment, with the identity and the turn it belongs to. */
export interface HappySessionEnvelope {
    ev: HappySessionEvent;
    id: string;
    role: "agent" | "user";
    time: number;
    turn?: string;
    usage?: HappyUsage;
}

/** An envelope wrapped for delivery, before encryption. */
export interface HappySessionProtocolMessage {
    content: HappySessionEnvelope;
    localId: string;
    meta: { sentFrom: "rig" };
    role: "session";
}

/** A message read back from Happy's own stream. */
export const happyRemoteMessageSchema = Type.Object(
    {
        content: Type.Object(
            { c: Type.String(), t: Type.Literal("encrypted") },
            { additionalProperties: true },
        ),
        createdAt: Type.Number(),
        id: Type.String({ minLength: 1 }),
        localId: Type.Union([Type.String(), Type.Null()]),
        seq: Type.Integer({ minimum: 0 }),
        updatedAt: Type.Number(),
    },
    { additionalProperties: true },
);
export type HappyRemoteMessage = Static<typeof happyRemoteMessageSchema>;

/** What the phone chose alongside the text it sent. */
export const happyRemoteSelectionSchema = Type.Object(
    {
        effort: Type.Optional(Type.String({ maxLength: 64 })),
        modelId: Type.Optional(Type.String({ maxLength: 256 })),
        permissionMode: Type.Optional(Type.String({ maxLength: 64 })),
        providerId: Type.Optional(Type.String({ maxLength: 128 })),
    },
    { additionalProperties: false },
);
export type HappyRemoteSelection = Static<typeof happyRemoteSelectionSchema>;

/**
 * What one decrypted remote message turned out to be.
 *
 * `echo` is Happy Agent's own message coming back; it carries nothing new and must not
 * be replayed into the conversation.
 */
export type HappyRemoteInput =
    | { kind: "echo" }
    | { kind: "attachment"; mimeType?: string; name: string; ref: string; size: number }
    | { kind: "text"; selection: HappyRemoteSelection; text: string };

/** Marks a message Happy Agent itself produced, so its echo can be recognized. */
export const HAPPY_SENT_FROM_RIG = "rig";

/** Namespaces the identity of a message that came from Happy. */
export function happyRemoteMessageId(remoteId: string): string {
    return `happy:${remoteId}`;
}
