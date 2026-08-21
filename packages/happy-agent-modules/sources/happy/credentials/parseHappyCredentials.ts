import { Value } from "@sinclair/typebox/value";

import {
    happyCredentialsFileSchema,
    type HappyCredentials,
    type StoredHappyCredentials,
} from "../HappyCredentials.js";

const KEY_BYTES = 32;

/**
 * Reads a Happy `access.key` file into usable credentials.
 *
 * A file carries exactly one encryption format: a legacy account secret, or a
 * data-key pair. Throws when the file is neither.
 */
export function parseHappyCredentials(value: unknown): {
    credentials: HappyCredentials;
    stored: StoredHappyCredentials;
} {
    if (!Value.Check(happyCredentialsFileSchema, value)) {
        throw new Error("The Happy credentials file is not in a format Happy Agent understands.");
    }
    const parsed = Value.Cast(happyCredentialsFileSchema, value);
    if ((parsed.secret === undefined) === (parsed.encryption === undefined)) {
        throw new Error("Happy credentials must contain exactly one encryption format.");
    }
    if (parsed.secret !== undefined) {
        return {
            credentials: {
                encryption: { secret: decodeKey(parsed.secret, "secret"), type: "legacy" },
                token: parsed.token,
            },
            stored: { secret: parsed.secret, token: parsed.token },
        };
    }
    const encryption = parsed.encryption!;
    return {
        credentials: {
            encryption: {
                machineKey: decodeKey(encryption.machineKey, "machine key"),
                publicKey: decodeKey(encryption.publicKey, "public key"),
                type: "dataKey",
            },
            token: parsed.token,
        },
        stored: {
            encryption: { machineKey: encryption.machineKey, publicKey: encryption.publicKey },
            token: parsed.token,
        },
    };
}

function decodeKey(value: string, name: string): Uint8Array {
    const decoded = new Uint8Array(Buffer.from(value, "base64"));
    if (decoded.length !== KEY_BYTES || Buffer.from(decoded).toString("base64") !== value) {
        throw new Error(`The Happy ${name} must be a 32-byte base64 value.`);
    }
    return decoded;
}
