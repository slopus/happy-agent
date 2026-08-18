import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentKV } from "@slopus/happy-agent-base";
import type { Context, MapAsyncLock } from "@steve.kite/stdlib";

import type { ComputeFileSystem, ComputePermissions } from "../Compute.js";

/** What one remembered read says: which file, and how old the copy that was read was. */
const fileReadSchema = Type.Object({ path: Type.String(), mtimeMs: Type.Number() });

/** The whole log, oldest first, as it is stored. */
const fileReadLogSchema = Type.Array(fileReadSchema);

/** Where the log lives inside the module's own store for one agent. */
const READS_KEY = "reads";

/**
 * How many files are remembered. The log is a guard against a blind edit, not a record of the
 * conversation, so only the files recently in hand are worth keeping and the oldest fall off.
 */
const MAX_REMEMBERED_READS = 512;

/**
 * What this agent has actually read, so that what it changes is something it has seen.
 *
 * A model that edits a file it never read is working from what it imagines the file contains, and
 * a model that edits a file changed since it read it is throwing away whoever changed it. Both
 * are refused here rather than discovered afterwards in a diff. Writing counts as reading: after
 * a write the agent knows exactly what the file holds, so the next edit is allowed to proceed.
 *
 * The log belongs to the agent's conversation rather than to a run, which is what lets a write
 * interrupted by a restart simply be made again: the file it left behind is one this agent has
 * read. Every change runs under that agent's keyed lock, since two tool calls in one turn may both
 * be reading files.
 */
export class FileReadLog {
    /** The module's durable store for this one agent. */
    readonly #kv: AgentKV;
    /** The lock every change to one agent's log takes. */
    readonly #lock: MapAsyncLock<string>;
    /** Whose log this is. */
    readonly #agentId: string;

    constructor(kv: AgentKV, lock: MapAsyncLock<string>, agentId: string) {
        this.#kv = kv;
        this.#lock = lock;
        this.#agentId = agentId;
    }

    /** Remember that this agent now knows what the file holds. */
    async record(ctx: Context, path: string, mtimeMs: number): Promise<void> {
        await this.#lock.runInLock(ctx, this.#agentId, async (lockCtx) => {
            await this.#record(lockCtx, path, mtimeMs);
        });
    }

    /**
     * Refuse a change to a file this agent has not read, or has read and something else has
     * changed since. A file that does not exist yet is nobody's work to lose, so creating one
     * needs no reading first. Any modification time other than the remembered one counts as a
     * change: a restored backup or a clock moved backwards leaves an older stamp on a file whose
     * contents are no longer the ones that were read.
     */
    async assertRead(
        ctx: Context,
        fs: ComputeFileSystem,
        permissions: ComputePermissions,
        path: string,
        options: { readonly allowUnread?: boolean } = {},
    ): Promise<void> {
        if (!(await fs.exists(permissions, path))) return;
        const entries = readLog(await this.#kv.read(ctx, READS_KEY));
        const known = entries.find((entry) => entry.path === path);
        if (known === undefined) {
            if (options.allowUnread === true) return;
            throw new Error(`This file has not been read yet. Read it before changing it: ${path}`);
        }
        const stat = await fs.stat(permissions, path);
        if (stat.mtimeMs !== known.mtimeMs) {
            throw new Error(
                `This file has changed since it was last read, so a change now would discard that work. Read it again first: ${path}`,
            );
        }
    }

    async #record(ctx: Context, path: string, mtimeMs: number): Promise<void> {
        await this.#kv.update(ctx, READS_KEY, (current) => {
            const kept = readLog(current).filter((entry) => entry.path !== path);
            kept.push({ path, mtimeMs });
            return kept.slice(-MAX_REMEMBERED_READS);
        });
    }
}

/** The stored log, or an empty one when nothing readable is there. */
function readLog(stored: unknown): { path: string; mtimeMs: number }[] {
    // A log written by another version guards nothing, and refusing every edit over it would be
    // worse than starting again: the files themselves are the durable thing here.
    return Value.Check(fileReadLogSchema, stored) ? [...stored] : [];
}
