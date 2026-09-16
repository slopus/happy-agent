import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { computeServiceExecutionSchema, type ComputeServiceExecution } from "../ComputeServices.js";

const missingSchema = Type.Object({ code: Type.Literal("ENOENT") });
export function servicePathIsMissing(error: unknown): boolean {
    return Value.Check(missingSchema, error);
}

export const serviceProcessIdentitySchema = Type.Object(
    {
        pid: Type.Integer({ minimum: 2, maximum: 2147483647 }),
        startTime: Type.String({ minLength: 1, maxLength: 32, pattern: "^[0-9]+$" }),
    },
    { additionalProperties: false },
);
export type ServiceProcessIdentity = Static<typeof serviceProcessIdentitySchema>;

export const serviceLifetimeSchema = Type.Object(
    {
        ...serviceProcessIdentitySchema.properties,
        executionReady: Type.Boolean(),
        children: Type.Array(serviceProcessIdentitySchema, { maxItems: 2 }),
    },
    { additionalProperties: false },
);
export type ServiceLifetime = Static<typeof serviceLifetimeSchema>;

/** Never repair permissions or follow aliases while opening an execution's private control files. */
export async function assertServiceExecution(execution: ComputeServiceExecution): Promise<void> {
    if (
        !Value.Check(computeServiceExecutionSchema, execution) ||
        resolve(execution.directory) !== execution.directory ||
        basename(execution.directory) !== execution.id ||
        dirname(execution.directory) === "/"
    ) {
        throw new Error("Invalid private service execution directory.");
    }
    await assertPrivateServiceDirectory(dirname(execution.directory));
}

export async function assertPrivateServiceDirectory(directory: string): Promise<void> {
    const metadata = await lstat(directory);
    if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        metadata.uid !== process.getuid?.() ||
        (metadata.mode & 0o077) !== 0 ||
        (await realpath(directory)) !== directory
    ) {
        throw new Error(
            "Service control directories must be private, canonical, and owned by the daemon user.",
        );
    }
}

/** Bounded descriptor reads also reject symlinks, public files, and non-regular control objects. */
export async function readServiceControlFile(path: string, maximumBytes: number): Promise<string> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const metadata = await file.stat();
        if (
            !metadata.isFile() ||
            metadata.uid !== process.getuid?.() ||
            (metadata.mode & 0o077) !== 0 ||
            metadata.size > maximumBytes
        ) {
            throw new Error("The service control file is not a bounded private regular file.");
        }
        const buffer = Buffer.alloc(maximumBytes + 1);
        let total = 0;
        for (;;) {
            const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
            total += bytesRead;
            if (total > maximumBytes)
                throw new Error("The service control file exceeds its size limit.");
            if (bytesRead === 0) return buffer.subarray(0, total).toString("utf8");
        }
    } finally {
        await file.close();
    }
}

export async function writeServiceControlFile(path: string, contents: string): Promise<void> {
    if (Buffer.byteLength(contents) > 1048576)
        throw new Error("The service policy exceeds its size limit.");
    const file = await open(path, "wx", 0o600);
    try {
        await file.writeFile(contents, "utf8");
        await file.sync();
    } finally {
        await file.close();
    }
}
