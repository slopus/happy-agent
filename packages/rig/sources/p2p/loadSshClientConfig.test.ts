import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { P2pSshPeer } from "./P2pPeer.js";
import { loadSshClientConfig } from "./loadSshClientConfig.js";

const basePeer: P2pSshPeer = {
    auth: "agent",
    host: "rig.example.com",
    hostKeySha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    port: 22,
    remoteRig: "rig",
    username: "steve",
};

describe("SSH P2P authentication", () => {
    it("uses an SSH agent and strictly verifies the configured host key", async () => {
        const config = await loadSshClientConfig(basePeer, {
            SSH_AUTH_SOCK: "/tmp/test-agent.sock",
        });
        expect(config.agent).toBe("/tmp/test-agent.sock");
        const verify = config.hostVerifier as (fingerprint: string) => boolean;
        expect(verify("00".repeat(32))).toBe(true);
        expect(verify("11".repeat(32))).toBe(false);
    });

    it("loads a bounded private key and passphrase from trusted machine settings", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-ssh-auth-"));
        const path = join(directory, "id_ed25519");
        try {
            await writeFile(path, "private key");
            const config = await loadSshClientConfig(
                {
                    ...basePeer,
                    auth: "private_key",
                    passphraseEnvVar: "RIG_TEST_SSH_PASSPHRASE",
                    privateKeyPath: path,
                },
                { RIG_TEST_SSH_PASSPHRASE: "secret" },
            );
            expect(config.privateKey?.toString()).toBe("private key");
            expect(config.passphrase).toBe("secret");
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });
});
