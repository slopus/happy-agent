import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Value } from "@sinclair/typebox/value";

import { accountLinkCredentialsSchema, type AccountLinkCredentials } from "../AccountLink.js";

/** Read the stored link, or `undefined` when this machine is not linked. */
export async function readAccountLinkCredentials(
    path: string,
): Promise<AccountLinkCredentials | undefined> {
    let source: string;
    try {
        source = await readFile(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(source);
    } catch {
        parsed = undefined;
    }
    if (!Value.Check(accountLinkCredentialsSchema, parsed)) {
        throw new Error("The stored Happy account link is unreadable. Unlink and link again.");
    }
    return parsed;
}

/**
 * Replace the stored link atomically. Accounts retires a refresh token the moment it issues the
 * next one, so a half-written file would sign the machine out.
 */
export async function writeAccountLinkCredentials(
    path: string,
    credentials: AccountLinkCredentials,
): Promise<void> {
    if (!Value.Check(accountLinkCredentialsSchema, credentials)) {
        throw new Error("The Happy account link to store is invalid.");
    }
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    await chmod(dirname(path), 0o700);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, `${JSON.stringify(credentials)}\n`, { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
    }
}

export async function deleteAccountLinkCredentials(path: string): Promise<void> {
    await rm(path, { force: true });
}
