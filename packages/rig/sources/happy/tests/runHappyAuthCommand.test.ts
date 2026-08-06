import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
    NACL_NONCE_BYTES,
    nobleBoxKeyPairFromSecretKey,
    nobleBoxSeal,
} from "../../crypto/nobleNaCl.js";
import { runHappyAuthCommand } from "../runHappyAuthCommand.js";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("runHappyAuthCommand", () => {
    it("stores v2 credentials from the mobile QR flow and reloads the daemon", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-auth-"));
        directories.push(directory);
        const keyPair = nobleBoxKeyPairFromSecretKey(new Uint8Array(32).fill(3));
        const accountPublicKey = new Uint8Array(32).fill(8);
        const responseBundle = encryptAuthenticationResponse(keyPair.publicKey, accountPublicKey);
        let requestCount = 0;
        const request = vi.fn<typeof fetch>(async () => {
            requestCount += 1;
            return Response.json(
                requestCount === 1
                    ? { state: "pending" }
                    : {
                          response: Buffer.from(responseBundle).toString("base64"),
                          state: "authorized",
                          token: "happy-token",
                      },
            );
        });
        const onAuthenticated = vi.fn(async () => undefined);
        const renderQrCode = vi.fn(async () => undefined);

        await expect(
            runHappyAuthCommand({
                environment: { RIG_HAPPY_SERVER_URL: "https://happy.test/" },
                fetch: request,
                homeDirectory: directory,
                keyPair,
                onAuthenticated,
                pollIntervalMs: 0,
                renderQrCode,
                rigHome: join(directory, ".happy", "rig"),
            }),
        ).resolves.toBe(true);

        const stored = JSON.parse(
            await readFile(join(directory, ".happy", "rig", "happy", "access.key"), "utf8"),
        ) as Record<string, any>;
        expect(stored.token).toBe("happy-token");
        expect(stored.encryption.publicKey).toBe(Buffer.from(accountPublicKey).toString("base64"));
        expect(Buffer.from(stored.encryption.machineKey, "base64")).toHaveLength(32);
        expect(renderQrCode).toHaveBeenCalledWith(expect.stringMatching(/^happy:\/\/terminal\?/u));
        expect(onAuthenticated).toHaveBeenCalledOnce();
    });
});

function encryptAuthenticationResponse(
    recipientPublicKey: Uint8Array,
    accountPublicKey: Uint8Array,
): Uint8Array {
    const sender = nobleBoxKeyPairFromSecretKey(new Uint8Array(32).fill(4));
    const nonce = new Uint8Array(NACL_NONCE_BYTES).fill(5);
    const plaintext = new Uint8Array(33);
    plaintext[0] = 0;
    plaintext.set(accountPublicKey, 1);
    const ciphertext = nobleBoxSeal(plaintext, nonce, recipientPublicKey, sender.secretKey);
    const bundle = new Uint8Array(sender.publicKey.length + nonce.length + ciphertext.length);
    bundle.set(sender.publicKey, 0);
    bundle.set(nonce, sender.publicKey.length);
    bundle.set(ciphertext, sender.publicKey.length + nonce.length);
    return bundle;
}
