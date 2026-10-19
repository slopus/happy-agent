import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { agentDatabase, agentDatabaseConnection, type AgentKV } from "@slopus/happy-agent-base";
import type { ComputeFileSystem, ComputePermissions } from "@slopus/happy-agent-compute";
import { createContextNamespace, type Context, type MapAsyncLock } from "@steve.kite/stdlib";

/** What one remembered read says: which file, and how old the copy that was read was. */
const fileReadSchema = Type.Object({ path: Type.String(), mtimeMs: Type.Number() });

/** The whole log, oldest first, as it is stored. */
const fileReadLogSchema = Type.Array(fileReadSchema);

/**
 * The files whose change locks the current context already holds. A patch changes several files
 * through the same write, move, and delete helpers a single edit uses, and each of them serializes
 * itself; carrying the held locks on the context lets the outer change keep them instead of
 * waiting on itself.
 */
const heldChangeLocks = createContextNamespace<readonly string[]>("happy.fileChangeLocks", []);

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
 * read. Every change enters its database-owned operation before taking that agent's keyed lock.
 * Two tool calls in one turn may both be reading files, and keeping that one lock order prevents
 * a transactional read from deadlocking with a nontransactional edit.
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

    /**
     * Run one file change — its staleness check, read, write, and the record of what it wrote — as
     * a single step for every file it touches.
     *
     * A model may ask for several edits to one file in a single batch, and those calls run
     * concurrently. Checked and written separately, the second edit could pass its check against
     * the timestamp the first was about to replace, read the content the first was about to change,
     * and silently write over it, while every later edit saw the first edit's new timestamp before
     * it was recorded and was refused as stale. A parent and the agent it started can race the same
     * way on a file they share. The lock is therefore keyed by path and shared by every agent the
     * compute module serves, so concurrent changes to one file behave like the same changes made one
     * after another, whoever makes them, while changes to different files still run side by side.
     * Paths are locked in sorted order so a patch spanning several files cannot deadlock another.
     */
    async change<Result>(
        ctx: Context,
        paths: readonly string[],
        work: (ctx: Context) => Promise<Result>,
    ): Promise<Result> {
        const held = heldChangeLocks.get(ctx);
        const keys = [...new Set(paths.map((path) => `change:${path}`))]
            .filter((key) => !held.includes(key))
            .sort();
        const enter = async (index: number, lockCtx: Context): Promise<Result> => {
            const key = keys[index];
            if (key === undefined) return await work(lockCtx);
            return await this.#lock.runInLock(
                lockCtx,
                key,
                async (innerCtx) =>
                    await enter(
                        index + 1,
                        heldChangeLocks.set(innerCtx, [...heldChangeLocks.get(innerCtx), key]),
                    ),
            );
        };
        return await enter(0, ctx);
    }

    /** Remember that this agent now knows what the file holds. */
    async record(ctx: Context, path: string, mtimeMs: number): Promise<void> {
        const database = agentDatabase(ctx);
        const connection = database === undefined ? undefined : agentDatabaseConnection(database);
        if (database !== undefined && connection !== undefined) {
            await connection.operation(database, async () => {
                await this.#recordInLock(ctx, path, mtimeMs);
            });
            return;
        }
        await this.#kv.transaction(ctx, async (_kv, txCtx) => {
            await this.#recordInLock(txCtx, path, mtimeMs);
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
        if (await this.isStale(ctx, fs, permissions, path)) throw staleFileError(path);
    }

    /** Whether the agent remembers this file and something has changed it since. */
    async isStale(
        ctx: Context,
        fs: ComputeFileSystem,
        permissions: ComputePermissions,
        path: string,
    ): Promise<boolean> {
        if (!(await fs.exists(permissions, path))) return false;
        const entries = readLog(await this.#kv.read(ctx, READS_KEY));
        const known = entries.find((entry) => entry.path === path);
        if (known === undefined) return false;
        const stat = await fs.stat(permissions, path);
        return stat.mtimeMs !== known.mtimeMs;
    }

    async #record(ctx: Context, path: string, mtimeMs: number): Promise<void> {
        await this.#kv.update(ctx, READS_KEY, (current) => {
            const kept = readLog(current).filter((entry) => entry.path !== path);
            kept.push({ path, mtimeMs });
            return kept.slice(-MAX_REMEMBERED_READS);
        });
    }

    async #recordInLock(ctx: Context, path: string, mtimeMs: number): Promise<void> {
        await this.#lock.runInLock(ctx, this.#agentId, async (lockCtx) => {
            await this.#record(lockCtx, path, mtimeMs);
        });
    }
}

/** The refusal for a change based on a remembered copy that is no longer current. */
export function staleFileError(path: string): Error {
    return new Error(
        `This file has changed since it was last read, so a change now would discard that work. Read it again first: ${path}`,
    );
}

/** The stored log, or an empty one when nothing readable is there. */
function readLog(stored: unknown): { path: string; mtimeMs: number }[] {
    // A log written by another version guards nothing, and refusing every edit over it would be
    // worse than starting again: the files themselves are the durable thing here.
    return Value.Check(fileReadLogSchema, stored) ? [...stored] : [];
}
