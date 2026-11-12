import { agentDatabase, type AgentKV } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

/** Transactions currently open on a database that can sync its WAL, as their Drizzle facades. */
const openTransactions = new WeakSet<object>();
/** Open transactions that asked to survive an OS crash. */
const durableTransactions = new WeakSet<object>();
/** How to make everything committed so far durable, by root Drizzle database. */
const durableFlushes = new WeakMap<object, () => Promise<void>>();

/**
 * Make the work carried by `ctx` survive an OS crash or power loss, not only a daemon crash.
 *
 * Commits normally return before SQLite syncs the WAL. Call this before the daemon acts outside
 * itself on what it wrote: before a tool runs, before acknowledging what a person sent or
 * decided, before spending a credential the server has just rotated. Inside a transaction the
 * sync happens right after it commits, before the transaction returns and before its after-commit
 * work; outside one, it happens now. Either way it also makes every earlier commit durable. A
 * context without a database, or a database that registered no flush, keeps its own synchronous
 * setting, so nothing is done there.
 */
export async function requireDurableCommit(ctx: Context): Promise<void> {
    const database = agentDatabase(ctx);
    if (database === undefined) return;
    if (openTransactions.has(database)) {
        durableTransactions.add(database);
        return;
    }
    await durableFlushes.get(database)?.();
}

/**
 * `kv.getOrCreate`, made durable before the caller acts on the value. A durable tool runs again
 * after a crash, and must find the same ID rather than create its folder or clone twice.
 */
export async function getOrCreateDurably<Value>(
    ctx: Context,
    kv: AgentKV,
    key: string,
    create: () => Value | Promise<Value>,
): Promise<Value> {
    const value = await kv.getOrCreate(ctx, key, create);
    await requireDurableCommit(ctx);
    return value;
}

/** Let `requireDurableCommit` flush this root database outside a transaction. */
export function registerDurableFlush(database: object, flush: () => Promise<void>): void {
    durableFlushes.set(database, flush);
}

/** Track one transaction while its work runs. */
export function openDurableTransaction(transaction: object): void {
    openTransactions.add(transaction);
}

/** Stop tracking a transaction, and say whether its commit must be made durable. */
export function closeDurableTransaction(transaction: object): boolean {
    openTransactions.delete(transaction);
    return durableTransactions.has(transaction);
}
