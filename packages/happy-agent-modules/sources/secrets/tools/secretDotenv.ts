import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseEnv } from "node:util";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { SecretHostEnvironment } from "../Secret.js";
import { assertSecretHostEnvironment } from "../SecretStore.js";

const MAX_SECRET_DOTENV_BYTES = 1_048_576;

export const secretDotenvFileSchema = Type.String({
    minLength: 1,
    maxLength: 4_096,
    pattern: "^[^\\u0000]+$",
    description:
        "Absolute path to a UTF-8 .env file whose complete environment bundle should be stored. The file is read host-side after review; its values are never returned.",
});

/** Read one bounded dotenv file without ever including its contents in an error. */
export async function readSecretDotenv(path: string): Promise<SecretHostEnvironment> {
    if (!Value.Check(secretDotenvFileSchema, path) || !isAbsolute(path)) {
        throw new Error("A secret dotenv source must be an absolute file path.");
    }

    let file: Awaited<ReturnType<typeof open>>;
    try {
        // Non-blocking open lets the regular-file check reject a FIFO without waiting for a writer.
        file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch {
        throw new Error(`Could not open the secret dotenv file ${JSON.stringify(path)}.`);
    }

    let bytes: Uint8Array;
    try {
        const facts = await file.stat();
        if (!facts.isFile()) throw new Error("not a file");
        if (facts.size > MAX_SECRET_DOTENV_BYTES) throw new Error("too large");

        const buffer = Buffer.alloc(MAX_SECRET_DOTENV_BYTES + 1);
        let offset = 0;
        while (offset < buffer.byteLength) {
            const chunk = await file.read(buffer, offset, buffer.byteLength - offset, offset);
            if (chunk.bytesRead === 0) break;
            offset += chunk.bytesRead;
        }
        if (offset > MAX_SECRET_DOTENV_BYTES) throw new Error("too large");
        bytes = buffer.subarray(0, offset);
    } catch {
        throw new Error(
            `The secret dotenv source ${JSON.stringify(path)} must be a regular file no larger than 1 MiB.`,
        );
    } finally {
        await file.close().catch(() => undefined);
    }

    let parsed: NodeJS.Dict<string>;
    try {
        const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        parsed = parseEnv(source);
    } catch {
        throw new Error("The secret dotenv file is not valid UTF-8 dotenv syntax.");
    }

    const environment = Object.create(null) as Record<string, string>;
    for (const [name, value] of Object.entries(parsed)) {
        if (value === undefined) {
            throw new Error("The secret dotenv file contains an invalid environment entry.");
        }
        Object.defineProperty(environment, name, {
            configurable: true,
            enumerable: true,
            value,
            writable: true,
        });
    }

    try {
        assertSecretHostEnvironment(environment);
    } catch {
        throw new Error(
            "The secret dotenv file contains invalid, colliding, or oversized environment entries.",
        );
    }
    if (Object.keys(environment).length === 0) {
        throw new Error("The secret dotenv file must contain at least one environment variable.");
    }
    return environment;
}
