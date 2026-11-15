import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { deterministicStringify, type Context } from "@steve.kite/stdlib";

import type { SessionMessage } from "@/core/SessionContext.js";

/**
 * Where one Happy conversation stands inside its foreign agent's own session.
 *
 * The foreign agent keeps its native context; Happy keeps the canonical transcript. This record
 * is the join between them: which ACP session continues this conversation, and how much of the
 * Happy transcript that session has already seen. `fingerprint` covers exactly that prefix, so a
 * compaction, a provider switch, or an edited history is detected and answered with a fresh
 * session and a replay instead of silently continuing a context that no longer matches.
 */
export interface AcpSessionRecord {
    readonly acpSessionId: string;
    readonly cwd: string;
    readonly consumed: number;
    readonly fingerprint: string;
    /** The driver materialized its native session from an in-memory SDK store. */
    readonly replayRequired?: boolean;
}

function recordPath(directory: string, id: string): string {
    return join(directory, "sessions", `${encodeURIComponent(id)}.json`);
}

export async function acpSessionRecordRead(
    directory: string,
    id: string,
): Promise<AcpSessionRecord | undefined> {
    try {
        const raw = JSON.parse(await readFile(recordPath(directory, id), "utf8")) as unknown;
        if (
            typeof raw === "object" &&
            raw !== null &&
            typeof (raw as AcpSessionRecord).acpSessionId === "string" &&
            typeof (raw as AcpSessionRecord).cwd === "string" &&
            typeof (raw as AcpSessionRecord).consumed === "number" &&
            typeof (raw as AcpSessionRecord).fingerprint === "string"
        ) {
            return raw as AcpSessionRecord;
        }
        return undefined;
    } catch {
        return undefined;
    }
}

export async function acpSessionRecordWrite(
    directory: string,
    id: string,
    record: AcpSessionRecord,
): Promise<void> {
    const path = recordPath(directory, id);
    await mkdir(join(directory, "sessions"), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, path);
}

/** Forget where the conversation stood, so a later process cannot continue a session it replaced. */
export async function acpSessionRecordClear(
    directory: string,
    id: string,
    ctx?: Context,
): Promise<void> {
    const path = recordPath(directory, id);
    try {
        await rm(path, { force: true });
    } catch (error) {
        if ((error as { code?: string })?.code !== "ENOENT") {
            ctx?.log.warn(
                "Could not remove replaced ACP session record; writing tombstone.",
                { id, path },
                error,
            );
            // Overwrite with an invalid tombstone record so a stale pre-compaction session cannot be resumed.
            try {
                await writeFile(path, "{}", { mode: 0o600 });
            } catch (tombstoneError) {
                throw new Error(
                    `Failed to clear or invalidate ACP session record for ${id}: ${String(tombstoneError)}`,
                    { cause: error },
                );
            }
        }
    }
}

/**
 * Identity of a transcript prefix as far as the foreign agent is concerned: what people and
 * agents said. Assistant and tool records are deliberately left out — their canonical form is
 * re-derived by Agent Base, while the words that entered the conversation never change.
 */
export function acpTranscriptFingerprint(messages: readonly SessionMessage[]): string {
    const hash = createHash("sha256");
    hash.update(String(messages.length));
    for (const message of messages) {
        hash.update(`\u0000${message.role}`);
        if (message.role === "compaction") {
            // A replacement can have the same message count as the checkpoint an account
            // saw before. Its actual summary and opaque payload define that new prefix.
            hash.update(
                deterministicStringify([
                    message.content,
                    message.encryptedContent,
                    message.vendor ?? null,
                ]),
            );
            continue;
        }
        if (message.role !== "user" && message.role !== "agent") continue;
        for (const block of message.content) {
            if (block.type === "text") hash.update(block.text);
        }
    }
    return hash.digest("hex");
}
