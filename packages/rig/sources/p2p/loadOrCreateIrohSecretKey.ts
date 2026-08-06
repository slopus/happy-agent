import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { SecretKey } from "@number0/iroh/index.js";
import { loadIrohBindings } from "./loadIrohBindings.js";

const secretKeyBytesSchema = Type.Array(Type.Integer({ maximum: 255, minimum: 0 }), {
    maxItems: 32,
    minItems: 32,
});

export async function loadOrCreateIrohSecretKey(path: string): Promise<SecretKey> {
    const { SecretKey } = await loadIrohBindings();
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    try {
        return SecretKey.fromBytes(await readSecretKeyBytes(path));
    } catch (error) {
        if (!isMissingFile(error)) throw error;
    }

    const generated = SecretKey.generate();
    const bytes = Buffer.from(generated.toBytes());
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    let file;
    try {
        file = await open(
            temporaryPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
            0o600,
        );
        await file.writeFile(bytes);
        await file.sync();
        await file.close();
        file = undefined;
        await link(temporaryPath, path);
    } catch (error) {
        if (!isExistingFile(error)) throw error;
        return SecretKey.fromBytes(await readSecretKeyBytes(path));
    } finally {
        await file?.close();
        await rm(temporaryPath, { force: true });
    }
    await chmod(path, 0o600);
    return generated;
}

async function readSecretKeyBytes(path: string): Promise<number[]> {
    const file = await open(path, constants.O_NOFOLLOW | constants.O_RDONLY);
    try {
        await file.chmod(0o600);
        const bytes = [...(await file.readFile())];
        if (!Value.Check(secretKeyBytesSchema, bytes)) {
            throw new Error("The saved Iroh endpoint identity must contain exactly 32 bytes.");
        }
        return bytes;
    } finally {
        await file.close();
    }
}

function isMissingFile(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isExistingFile(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "EEXIST";
}
