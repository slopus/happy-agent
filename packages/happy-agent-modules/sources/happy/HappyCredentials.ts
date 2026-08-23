import { Type, type Static } from "@sinclair/typebox";

/**
 * Which envelope Happy uses for this account.
 *
 * `legacy` accounts encrypt every payload directly with the account secret.
 * `dataKey` accounts encrypt with a per-scope AES key that is wrapped to the
 * account public key, so the account secret never leaves the phone.
 */
export const happyEncryptionVariantSchema = Type.Union([
    Type.Literal("dataKey"),
    Type.Literal("legacy"),
]);
export type HappyEncryptionVariant = Static<typeof happyEncryptionVariantSchema>;

/** The `access.key` file as Happy writes it. Unknown fields are preserved by Happy and ignored here. */
export const happyCredentialsFileSchema = Type.Object({
    encryption: Type.Optional(
        Type.Object({
            machineKey: Type.String({ minLength: 1 }),
            publicKey: Type.String({ minLength: 1 }),
        }),
    ),
    secret: Type.Optional(Type.String({ minLength: 1 })),
    token: Type.String({ minLength: 1 }),
});
export type HappyCredentialsFile = Static<typeof happyCredentialsFileSchema>;

/** The credentials exactly as they are stored back to disk, with keys still base64. */
export const storedHappyCredentialsSchema = Type.Object({
    encryption: Type.Optional(
        Type.Object({
            machineKey: Type.String({ minLength: 1 }),
            publicKey: Type.String({ minLength: 1 }),
        }),
    ),
    secret: Type.Optional(Type.String({ minLength: 1 })),
    token: Type.String({ minLength: 1 }),
});
export type StoredHappyCredentials = Static<typeof storedHappyCredentialsSchema>;

/** The credentials in the form the clients use, with keys decoded to raw bytes. */
export type HappyCredentials =
    | {
          encryption: { secret: Uint8Array; type: "legacy" };
          token: string;
      }
    | {
          encryption: { machineKey: Uint8Array; publicKey: Uint8Array; type: "dataKey" };
          token: string;
      };

/** Everything the Happy clients need to reach the account this machine is signed in to. */
export interface HappyConnectionConfiguration {
    /** Canonical SHA-256 identity of the stored credentials, safe to compare and persist. */
    credentialFingerprint: string;
    credentials: HappyCredentials;
    credentialsPath: string;
    /** The directory holding this agent's copy of the Happy credentials, settings and machine identity. */
    happyHome: string;
    /** Whether the credentials were just copied in from a Happy CLI installation. */
    imported: boolean;
    machineId?: string;
    serverUrl: string;
}
