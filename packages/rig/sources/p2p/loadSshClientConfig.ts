import { timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

import type { ConnectConfig } from "ssh2";

import type { P2pSshPeer } from "./P2pPeer.js";

const MAXIMUM_PRIVATE_KEY_BYTES = 1024 * 1024;

export async function loadSshClientConfig(
    peer: P2pSshPeer,
    environment: NodeJS.ProcessEnv = process.env,
): Promise<ConnectConfig> {
    const authentication =
        peer.auth === "agent"
            ? { agent: requireAgentSocket(peer, environment) }
            : await readPrivateKeyAuthentication(peer, environment);
    const expectedHostHash = Buffer.from(peer.hostKeySha256.slice("SHA256:".length), "base64")
        .toString("hex")
        .toLowerCase();
    return {
        ...authentication,
        host: peer.host,
        hostHash: "sha256",
        hostVerifier: (fingerprint: string) =>
            equalVisibleAscii(fingerprint.toLowerCase(), expectedHostHash),
        keepaliveCountMax: 3,
        keepaliveInterval: 15_000,
        port: peer.port,
        readyTimeout: 15_000,
        strictVendor: true,
        username: peer.username,
    };
}

function requireAgentSocket(peer: P2pSshPeer, environment: NodeJS.ProcessEnv): string {
    const socket = peer.agentSocketPath ?? environment.SSH_AUTH_SOCK?.trim();
    if (socket === undefined || socket.length === 0) {
        throw new Error("The trusted SSH connection needs an agent socket path or SSH_AUTH_SOCK.");
    }
    return socket;
}

async function readPrivateKeyAuthentication(
    peer: P2pSshPeer,
    environment: NodeJS.ProcessEnv,
): Promise<Pick<ConnectConfig, "passphrase" | "privateKey">> {
    if (peer.privateKeyPath === undefined) {
        throw new Error("SSH private-key authentication requires a private key path.");
    }
    const file = await open(peer.privateKeyPath, constants.O_NOFOLLOW | constants.O_RDONLY);
    try {
        const stats = await file.stat();
        if (stats.size === 0 || stats.size > MAXIMUM_PRIVATE_KEY_BYTES) {
            throw new Error("The configured SSH private key is empty or larger than 1 MB.");
        }
        const privateKey = await file.readFile();
        const passphrase =
            peer.passphraseEnvVar === undefined
                ? undefined
                : environment[peer.passphraseEnvVar]?.trim();
        if (peer.passphraseEnvVar !== undefined && !passphrase) {
            throw new Error(
                `SSH private-key authentication requires ${peer.passphraseEnvVar} in the environment.`,
            );
        }
        return {
            privateKey,
            ...(passphrase === undefined ? {} : { passphrase }),
        };
    } finally {
        await file.close();
    }
}

function equalVisibleAscii(left: string, right: string): boolean {
    const leftBytes = Buffer.from(left, "ascii");
    const rightBytes = Buffer.from(right, "ascii");
    return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}
