import { Type, type Static } from "@sinclair/typebox";

/** One thing to tell a person on their phone. */
export const pushNotificationSchema = Type.Object(
    {
        /** One ID per notification, the same on every phone it reaches, so a phone shows it once. */
        notificationId: Type.String({ minLength: 1, maxLength: 256 }),
        title: Type.String({ maxLength: 4096 }),
        /** The second line; empty when there is none. */
        body: Type.String({ maxLength: 4096 }),
        /** The agent the notification is about, which the phone opens. */
        agentId: Type.String({ minLength: 1, maxLength: 128 }),
        /** A later notification with the same value replaces the earlier one on the phone. */
        collapseId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" })),
    },
    { additionalProperties: false },
);
export type PushNotification = Static<typeof pushNotificationSchema>;

/** Why the relay refused a notification outright. Fixed words only: its text may echo a token. */
export type PushRejection =
    | "invalid_credentials"
    | "message_too_big"
    | "mismatch_sender_id"
    | "redirect_refused"
    | "request_rejected";

/**
 * What became of one notification sent to one phone.
 *
 * - `accepted` — the relay took it; this is not proof the phone showed it.
 * - `unregistered` — the relay no longer knows the phone, so its registration is removed.
 * - `unknown` — a timeout, a transport or server failure, or an answer that could not be read. It
 *   may have been delivered, and it is not sent again.
 * - `rejected` — the relay refused it and will refuse it again.
 */
export type PushDeliveryOutcome =
    | { readonly kind: "accepted" }
    | { readonly kind: "unregistered" }
    | { readonly kind: "unknown" }
    | { readonly kind: "rejected"; readonly reason: PushRejection };
