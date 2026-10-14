import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { gitChangeStateSchema, gitTrackedEntitySchema, type GitChangeState } from "../types.js";

/** Repositories remembered across restarts; the least recently scanned beyond this are dropped. */
const MAXIMUM_ENTRIES = 64;
/** One repository's remembered state above this size is not kept; it simply scans at start. */
const MAXIMUM_ENTRY_BYTES = 512 * 1024;
const MAXIMUM_FILE_BYTES = 8 * 1024 * 1024;
const WRITE_DELAY_MS = 5_000;

const rememberedSchema = Type.Object(
    {
        entity: gitTrackedEntitySchema,
        /** The worktree fingerprint the state was scanned at, when the scan produced one. */
        fingerprint: Type.Optional(Type.String()),
        key: Type.String({ minLength: 1 }),
        /** Whether binary file contents were left out, so the state must be scanned again. */
        partial: Type.Boolean(),
        savedAt: Type.Number(),
        state: gitChangeStateSchema,
    },
    { additionalProperties: false },
);
export type GitRememberedSnapshot = Static<typeof rememberedSchema>;

const fileSchema = Type.Object(
    {
        entries: Type.Array(rememberedSchema, { maxItems: MAXIMUM_ENTRIES }),
        version: Type.Literal(1),
    },
    { additionalProperties: false },
);

/**
 * The last Git state of each watched repository, kept on disk across daemon restarts.
 *
 * Without it every watched workspace is scanned in full the moment a client reconnects to a
 * restarted daemon, and on Windows each of those scans first starts that workspace's sandbox.
 * With it, a restarted daemon answers with what it last knew and only has to prove each state
 * still current, which a matching fingerprint does in one Git command.
 *
 * It is a cache, never a source of truth: anything missing, oversized, unreadable, or from
 * another version is treated as absent, and every write failure is ignored. Binary file
 * contents are not kept; a state that had them is shown at once but scanned again in full.
 */
export class GitSnapshotStore {
    readonly #entries = new Map<string, GitRememberedSnapshot>();
    readonly #path: string;
    #disposed = false;
    #timer: NodeJS.Timeout | undefined;
    #writing: Promise<void> = Promise.resolve();

    constructor(path: string) {
        this.#path = path;
    }

    /** Reads what the previous daemon left behind. Never throws. */
    async load(): Promise<void> {
        try {
            if ((await stat(this.#path)).size > MAXIMUM_FILE_BYTES) return;
            const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
            if (!Value.Check(fileSchema, parsed)) return;
            for (const entry of parsed.entries) {
                if (!this.#entries.has(entry.key)) this.#entries.set(entry.key, entry);
            }
        } catch {
            // Nothing remembered.
        }
    }

    get(key: string): GitRememberedSnapshot | undefined {
        return this.#entries.get(key);
    }

    /** Remembers one repository's latest state, written to disk a few seconds later. */
    remember(
        key: string,
        entity: GitRememberedSnapshot["entity"],
        state: GitChangeState,
        fingerprint: string | undefined,
    ): void {
        if (this.#disposed) return;
        const partial = state.files.some(
            (file) => file.oldBytes !== undefined || file.newBytes !== undefined,
        );
        const entry: GitRememberedSnapshot = {
            entity,
            ...(fingerprint === undefined ? {} : { fingerprint }),
            key,
            partial,
            savedAt: Date.now(),
            state: {
                ...state,
                files: state.files.map(
                    ({ newBytes: _newBytes, oldBytes: _oldBytes, ...file }) => file,
                ),
            },
        };
        this.#entries.delete(key);
        if (JSON.stringify(entry).length > MAXIMUM_ENTRY_BYTES) return;
        this.#entries.set(key, entry);
        while (this.#entries.size > MAXIMUM_ENTRIES) {
            const oldest = this.#entries.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.#entries.delete(oldest);
        }
        this.#schedule();
    }

    /** Writes anything pending and stops accepting new states. */
    async dispose(): Promise<void> {
        if (this.#disposed) return;
        this.#disposed = true;
        if (this.#timer !== undefined) {
            clearTimeout(this.#timer);
            this.#timer = undefined;
            this.#write();
        }
        await this.#writing;
    }

    #schedule(): void {
        if (this.#timer !== undefined) return;
        this.#timer = setTimeout(() => {
            this.#timer = undefined;
            this.#write();
        }, WRITE_DELAY_MS);
        this.#timer.unref();
    }

    #write(): void {
        // Oldest first, so a later load keeps the same recency order.
        const contents = JSON.stringify({ entries: [...this.#entries.values()], version: 1 });
        this.#writing = this.#writing.then(async () => {
            if (contents.length > MAXIMUM_FILE_BYTES) return;
            const temporary = `${this.#path}.${randomUUID()}.tmp`;
            try {
                await mkdir(dirname(this.#path), { mode: 0o700, recursive: true });
                await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
                await rename(temporary, this.#path);
            } catch {
                // A cache that could not be written is simply not there next time.
            } finally {
                await rm(temporary, { force: true }).catch(() => undefined);
            }
        });
    }
}
