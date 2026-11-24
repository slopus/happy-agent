import { cuid2Schema } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

/** Whose pairing and devices: a team user's installation-local ID, or the standalone person. */
export const STANDALONE_MOBILE_OWNER = "standalone";
export const mobileOwnerSchema = Type.Union([cuid2Schema, Type.Literal(STANDALONE_MOBILE_OWNER)]);
export type MobileOwner = Static<typeof mobileOwnerSchema>;

/** The dedicated socket: off by configuration, closed while unused, or opening, open, or failed. */
export const mobileConnectorStatusSchema = Type.Union([
    Type.Literal("disabled"),
    Type.Literal("closed"),
    Type.Literal("starting"),
    Type.Literal("open"),
    Type.Literal("failed"),
]);
export type MobileConnectorStatus = Static<typeof mobileConnectorStatusSchema>;

export const mobilePairingStatusSchema = Type.Union([
    Type.Literal("waiting"),
    Type.Literal("verifying"),
    Type.Literal("completed"),
    Type.Literal("rejected"),
    Type.Literal("expired"),
    Type.Literal("cancelled"),
    Type.Literal("failed"),
]);
export type MobilePairingStatus = Static<typeof mobilePairingStatusSchema>;

export const mobileDevicePlatformSchema = Type.Union([
    Type.Literal("ios"),
    Type.Literal("android"),
    Type.Literal("other"),
]);

/** Display text a phone chose about itself: bounded and free of control characters. */
export const mobileDeviceNameSchema = Type.String({
    maxLength: 128,
    minLength: 1,
    pattern: "^[^\\u0000-\\u001f\\u007f]+$",
});

export const mobileDeviceDescriptionSchema = Type.Object(
    { name: mobileDeviceNameSchema, platform: mobileDevicePlatformSchema },
    { additionalProperties: false },
);
export type MobileDeviceDescription = Static<typeof mobileDeviceDescriptionSchema>;

/** One paired phone as its owner sees it. Its token exists only on the phone. */
export const mobileDeviceSchema = Type.Object(
    {
        id: cuid2Schema,
        name: mobileDeviceNameSchema,
        platform: mobileDevicePlatformSchema,
        createdAt: Type.Integer({ minimum: 0 }),
        lastSeenAt: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);
export type MobileDevice = Static<typeof mobileDeviceSchema>;

/**
 * The owner's current or most recent pairing. `qr` is set only while the code can still be used;
 * `device` and `emoji` once the phone has revealed its key. A finished pairing stays until the
 * next start or cancel so the desktop can show how it ended.
 */
export const mobilePairingSnapshotSchema = Type.Object(
    {
        id: cuid2Schema,
        status: mobilePairingStatusSchema,
        qr: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
        expiresAt: Type.Integer({ minimum: 0 }),
        device: Type.Union([mobileDeviceDescriptionSchema, Type.Null()]),
        emoji: Type.Union([Type.Array(Type.String(), { maxItems: 4, minItems: 4 }), Type.Null()]),
        desktopConfirmed: Type.Boolean(),
        mobileConfirmed: Type.Boolean(),
        error: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    },
    { additionalProperties: false },
);
export type MobilePairingSnapshot = Static<typeof mobilePairingSnapshotSchema>;

/** Everything one owner sees about the mobile connector, versioned by a UUIDv7. */
export const mobileConnectorSnapshotSchema = Type.Object(
    {
        status: mobileConnectorStatusSchema,
        pairing: Type.Union([mobilePairingSnapshotSchema, Type.Null()]),
        devices: Type.Array(mobileDeviceSchema),
        error: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
        version: Type.String({ minLength: 36, maxLength: 36 }),
        updatedAt: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);
export type MobileConnectorSnapshot = Static<typeof mobileConnectorSnapshotSchema>;

/** A snapshot changed. Deliver it only to its owner. */
export interface MobileConnectorEvent {
    readonly owner: MobileOwner;
    readonly mobileConnector: MobileConnectorSnapshot;
}

export type MobileConnectorListener = (
    ctx: Context,
    event: MobileConnectorEvent,
) => void | Promise<void>;

/** One owner's paired phone that is being removed. Its ID is never used again. */
export interface MobileDeviceRemoval {
    readonly owner: MobileOwner;
    readonly deviceId: string;
}

/** Takes part in the transaction that removes a phone; a failure keeps the phone paired. */
export type MobileDeviceRemovedListener = (
    ctx: Context,
    removed: MobileDeviceRemoval,
) => Promise<void>;

/**
 * What a bearer credential on the connector's socket proved. A device acts as its owner until
 * `revoked` aborts; a pairing token may only start a handshake, and a handshake credential may
 * only drive its own handshake.
 */
export type MobileCredential =
    | {
          readonly kind: "device";
          readonly deviceId: string;
          readonly owner: MobileOwner;
          readonly revoked: AbortSignal;
      }
    | { readonly kind: "pairing"; readonly token: string }
    | { readonly kind: "handshake"; readonly handshakeId: string };

/** Where the API serves the connector's socket; the exposure forwards here. */
export interface MobileConnectorTransport {
    readonly host: string;
    readonly port: number;
}

/** The daemon's answer to a phone that started a handshake. */
export interface MobileHandshakeStart {
    readonly handshakeId: string;
    readonly publicKey: string;
    readonly nonce: string;
    readonly expiresAt: number;
}

/** What the phone learns about its handshake: cancelled and failed read as `rejected`. */
export type MobileHandshakeStatus =
    | { readonly status: "verifying" }
    | { readonly status: "completed"; readonly deviceId: string; readonly mac: string }
    | { readonly status: "rejected" }
    | { readonly status: "expired" };
