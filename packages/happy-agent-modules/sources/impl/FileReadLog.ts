import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentKV } from "@slopus/happy-agent-base";
import type { ComputeFileSystem, ComputePermissions } from "@slopus/happy-agent-compute";
import type { Context, MapAsyncLock } from "@steve.kite/stdlib";

/** What one remembered read says: which file, and how old the copy that was read was. */
const fileReadSchema = Type.Object({ path: Type.String(), mtimeMs: Type.Number() });

/** The whole log, oldest first, as it is stored. */
const fileReadLogSchema = Type.Array(fileReadSchema);

/** Where the log lives inside the module's own store for one agent. */
const READS_KEY = "reads";

/**
 * How many files are remembered. The log guards against changing a stale remembered file, not a
 * record of the conversation, so only the files recently in hand are worth keeping and the oldest
 * fall off.
 */
const MAX_REMEMBERED_READS = 512;

/**
 * What this agent has actually read or written, so later changes can detect stale knowledge.
 *
 * A file with no remembered read may be changed. Once the agent has read or written one, a later
 * change is refused if somebody else changed it in the meantime. Writing counts as reading: after
 * a write the agent knows exactly what the file holds, so the next edit can check the same state.
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
     * Refuse a change when the agent remembers this file and something else has changed it since.
     * A file with no remembered read is allowed. Any modification time other than the remembered
     * one counts as a change: a restored backup or a clock moved backwards leaves an older stamp
     * on a file whose contents are no longer the ones that were read.
     */
    async assertRead(
        ctx: Context,
        fs: ComputeFileSystem,
        permissions: ComputePermissions,
        path: string,
    ): Promise<void> {
        if (!(await fs.exists(permissions, path))) return;
        const entries = readLog(await this.#kv.read(ctx, READS_KEY));
        const known = entries.find((entry) => entry.path === path);
        if (known === undefined) return;
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
