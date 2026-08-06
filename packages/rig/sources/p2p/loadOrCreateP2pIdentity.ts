import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    createP2pInstanceIdentity,
    decodeBase64Url,
    encodeBase64Url,
    p2pInstanceIdSchema,
    p2pSecretSeedSchema,
    type P2pInstanceIdentity,
} from "./P2pIdentity.js";

const P2P_IDENTITY_SEED_BYTES = 32;
const storedIdentitySchema = Type.Object(
    {
        instanceId: p2pInstanceIdSchema,
        secretSeed: p2pSecretSeedSchema,
        version: Type.Literal(1),
    },
    { additionalProperties: false },
);

export async function loadOrCreateP2pIdentity(path: string): Promise<P2pInstanceIdentity> {
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    try {
        return await readIdentity(path);
    } catch (error) {
        if (!isMissingFile(error)) throw error;
    }

    const instanceId = createP2pInstanceIdentity().instanceId;
    const secretSeed = new Uint8Array(randomBytes(P2P_IDENTITY_SEED_BYTES));
    const stored = {
        instanceId,
        secretSeed: encodeBase64Url(secretSeed),
        version: 1 as const,
    };
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    let file;
    try {
        file = await open(
            temporaryPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
            0o600,
        );
        await file.writeFile(`${JSON.stringify(stored)}\n`, "utf8");
        await file.sync();
        await file.close();
        file = undefined;
        await link(temporaryPath, path);
    } catch (error) {
        if (!isExistingFile(error)) throw error;
        return await readIdentity(path);
    } finally {
        await file?.close();
        await rm(temporaryPath, { force: true });
    }
    await chmod(path, 0o600);
    return createP2pInstanceIdentity(instanceId, secretSeed);
}

async function readIdentity(path: string): Promise<P2pInstanceIdentity> {
    const file = await open(path, constants.O_NOFOLLOW | constants.O_RDONLY);
    try {
        await file.chmod(0o600);
        const parsed: unknown = JSON.parse(await file.readFile("utf8"));
        if (!Value.Check(storedIdentitySchema, parsed)) {
            throw new Error("The saved P2P instance identity is invalid.");
        }
        const secretSeed = decodeBase64Url(parsed.secretSeed);
        if (secretSeed.byteLength !== P2P_IDENTITY_SEED_BYTES) {
            throw new Error("The saved P2P instance identity is invalid.");
        }
        return createP2pInstanceIdentity(parsed.instanceId, secretSeed);
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
