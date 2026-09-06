import { randomUUID } from "node:crypto";
import { lstat, open, rename, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { drainWaitingForSchema } from "@slopus/happy-agent-client";

const MAX_STATE_BYTES = 512 * 1024;
const daemonDrainStateSchema = Type.Object(
    {
        version: Type.Literal(1),
        pid: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
        instance: Type.String({ minLength: 1, maxLength: 128 }),
        processIdentity: Type.String({ minLength: 1, maxLength: 16_384 }),
        phase: Type.Union([
            Type.Literal("ready"),
            Type.Literal("draining"),
            Type.Literal("drained"),
            Type.Literal("failed"),
        ]),
        waitingFor: Type.Array(drainWaitingForSchema, { maxItems: 128 }),
    },
    { additionalProperties: false },
);
export type DaemonDrainState = Static<typeof daemonDrainStateSchema>;

export function daemonDrainStatePath(directory: string): string {
    return join(directory, "drain.json");
}

/** Bounded, private, no-follow reads; this file contains no authentication material. */
export async function readDaemonDrainState(path: string): Promise<DaemonDrainState> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_STATE_BYTES || (stat.mode & 0o077) !== 0) {
            throw new Error("The local drain status file is not a private, bounded regular file.");
        }
        const bytes = Buffer.alloc(MAX_STATE_BYTES + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead > MAX_STATE_BYTES)
            throw new Error("The local drain status file is too large.");
        return Value.Parse(
            daemonDrainStateSchema,
            JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")),
        );
    } finally {
        await handle.close();
    }
}

/** Atomically replace one ephemeral status snapshot; never retain a progress history. */
export async function writeDaemonDrainState(path: string, state: DaemonDrainState): Promise<void> {
    const contents = JSON.stringify(Value.Parse(daemonDrainStateSchema, state));
    if (Buffer.byteLength(contents) > MAX_STATE_BYTES)
        throw new Error("The local drain status is too large.");
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporaryPath, contents, { mode: 0o600, flag: "wx" });
        await rename(temporaryPath, path);
    } finally {
        await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
        });
    }
}

export async function removeDaemonDrainState(path: string, instance: string): Promise<void> {
    try {
        if ((await lstat(path)).isSymbolicLink()) return;
        if ((await readDaemonDrainState(path)).instance === instance) await unlink(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}
