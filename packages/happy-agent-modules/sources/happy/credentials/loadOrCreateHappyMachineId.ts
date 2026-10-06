import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Reads this machine's Happy identity, creating it once if it is missing.
 *
 * The identity is published to a fresh file and then linked into place, so two
 * daemons racing to create it agree on whichever one landed first. A machine
 * identity that cannot be established is not fatal: Happy simply runs without
 * machine-scoped features.
 */
export async function loadOrCreateHappyMachineId(
    path: string,
    createId: () => string = randomUUID,
): Promise<string | undefined> {
    const existing = await readMachineId(path);
    if (existing !== undefined) return existing;
    const temporaryPath = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
    try {
        await mkdir(dirname(path), { mode: 0o700, recursive: true });
        const id = createId();
        await writeFile(temporaryPath, `${JSON.stringify({ id }, null, 2)}\n`, { mode: 0o600 });
        try {
            await link(temporaryPath, path);
            return id;
        } catch {
            // Another daemon created the identity first; its value is the one that counts.
            return await readMachineId(path);
        }
    } catch {
        return undefined;
    } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
}

/**
 * Replaces a machine identity Happy refused because another account owns it.
 *
 * Only the refused identity is removed, so a daemon that already replaced it keeps the newer one,
 * and the next identity is created exactly as a first one would be.
 */
export async function replaceHappyMachineId(
    path: string,
    refusedId: string,
    createId: () => string = randomUUID,
): Promise<string | undefined> {
    if ((await readMachineId(path)) === refusedId) {
        await rm(path, { force: true }).catch(() => undefined);
    }
    return await loadOrCreateHappyMachineId(path, createId);
}

async function readMachineId(path: string): Promise<string | undefined> {
    try {
        const stored = JSON.parse(await readFile(path, "utf8")) as unknown;
        if (typeof stored === "object" && stored !== null && !Array.isArray(stored)) {
            const id = (stored as { id?: unknown }).id;
            if (typeof id === "string" && id.trim().length > 0) return id.trim();
        }
    } catch {
        // A missing or malformed identity is replaced by whoever wins the link below.
    }
    return undefined;
}
