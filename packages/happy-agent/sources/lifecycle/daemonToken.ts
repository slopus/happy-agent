import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";

export async function readDaemonToken(tokenPath: string): Promise<string> {
    return (await readFile(tokenPath, "utf8")).trim();
}

export async function readDaemonTokenIfPresent(tokenPath: string): Promise<string | undefined> {
    try {
        return await readDaemonToken(tokenPath);
    } catch {
        return undefined;
    }
}

export async function writeDaemonToken(tokenPath: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const temporaryPath = `${tokenPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${token}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, tokenPath);
    await chmod(tokenPath, 0o600);
    return token;
}

/**
 * Keeps already-connected local clients authorized when the daemon process is replaced.
 *
 * The token file lives in the daemon's private state directory and is already restricted to the
 * current user. Rotating it on every daemon start strands clients whose event streams reconnect
 * after a reload: their immutable client connection still carries the previous token and the new
 * daemon rejects it with HTTP 401.
 */
export async function readOrCreateDaemonToken(tokenPath: string): Promise<string> {
    const existing = await readDaemonTokenIfPresent(tokenPath);
    if (existing === undefined || existing.length === 0) return writeDaemonToken(tokenPath);
    await chmod(tokenPath, 0o600);
    return existing;
}
