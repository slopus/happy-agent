import { createHash } from "node:crypto";

import type { HappyCredentials } from "../HappyCredentials.js";

/**
 * The identity of one Happy account on one server, as the sync store keys its sessions by.
 *
 * This is deliberately not a fingerprint of the token. A token is a credential: Happy rotates it,
 * a re-pairing mints another, and the same person signing in again arrives with a new one. Keying
 * sessions by the token made every new token look like a new account, so a re-linked account
 * threw away its remote sessions and their encryption keys and the phone could no longer read
 * what the daemon went on publishing. What does not change across tokens is the account's key
 * pair, so the public key is the account, and the server it lives on qualifies it. This is the
 * same identity `readHappyCliMachineId` already uses to recognize Happy CLI's account as ours.
 *
 * A legacy account has no key pair; its secret is the account, and hashing it exposes nothing.
 */
export function createHappyAccountFingerprint(
    credentials: HappyCredentials,
    serverUrl: string,
): string {
    const account =
        credentials.encryption.type === "dataKey"
            ? credentials.encryption.publicKey
            : credentials.encryption.secret;
    return createHash("sha256")
        .update(credentials.encryption.type)
        .update("\0")
        .update(account)
        .update("\0")
        .update(normalizeHappyServerUrl(serverUrl))
        .digest("hex")
        .slice(0, 32);
}

/** One spelling for one server, so a trailing slash or a default port does not split an account. */
export function normalizeHappyServerUrl(serverUrl: string): string {
    return new URL(serverUrl).toString().replace(/\/+$/u, "");
}
