import { withLifetime, type Context } from "@steve.kite/stdlib";

import type { AgentPersistence } from "./AgentPersistence.js";

/**
 * A key-value store scoped under one prefix of the agent's sorted store. The agent carries a
 * session-scoped instance on its context, and narrows it for each caller: a module works
 * under its own name, a tool execution under its call ID. Keys are always relative to the
 * scope — a holder can neither see nor touch anything outside it. Segments join with `.`.
 *
 * Every operation runs on the context it is given, so that context decides which transaction a
 * write joins. Most handles also take their lifetime from that context; explicitly bounded
 * handles, such as a tool call's KV, additionally become unusable when their owner ends.
 */
export class AgentKV {
    /** The absolute key prefix of this scope, ending with the separator. */
    readonly prefix: string;

    /** The append-only store this scope reads and writes through. */
    readonly #persistence: AgentPersistence;
    /** An object-owned lifetime used by bounded stores such as one tool invocation's KV. */
    readonly #available: () => boolean;
    /** Build a scope over `prefix` of `persistence`. */
    constructor(persistence: AgentPersistence, prefix: string, available = () => true) {
        this.#persistence = persistence;
        this.prefix = prefix;
        this.#available = available;
    }

    /**
     * A narrower store under `segments` within this scope. Each segment is exactly one level:
     * a dot inside a segment is escaped, so the scope `alpha.beta` cannot be reached through
     * the scope `alpha` under the relative key `beta.…`, and two scopes stay distinct whenever
     * their segment lists differ.
     */
    scoped(...segments: readonly string[]): AgentKV {
        const escaped = segments.map((segment) =>
            segment.replaceAll("%", "%25").replaceAll(".", "%2E"),
        );
        return new AgentKV(
            this.#persistence,
            `${this.prefix}${escaped.join(".")}.`,
            this.#available,
        );
    }

    /**
     * A handle to this exact scope that becomes permanently unusable when `signal` aborts.
     * Narrower scopes inherit the same bound. Agent base uses this for call KV so no context can
     * recreate invocation state after the winning result erases it.
     */
    until(signal: AbortSignal, available = () => true): AgentKV {
        return new AgentKV(
            this.#persistence,
            this.prefix,
            () => this.#available() && !signal.aborted && available(),
        );
    }

    /** The stored value, or undefined when the key is absent. */
    async read(ctx: Context, key: string): Promise<unknown> {
        this.#assertLive(ctx);
        const full = `${this.prefix}${key}`;
        const entries = await this.#persistence.readValues(ctx, full);
        return entries.find((entry) => entry.key === full)?.value;
    }

    /** Every entry under the scope — or under `prefix` within it — with scope-relative keys. */
    async list(
        ctx: Context,
        prefix = "",
    ): Promise<readonly { readonly key: string; readonly value: unknown }[]> {
        this.#assertLive(ctx);
        const entries = await this.#persistence.readValues(ctx, `${this.prefix}${prefix}`);
        return entries.map(({ key, value }) => ({
            key: key.slice(this.prefix.length),
            value,
        }));
    }

    /** Store the value under `key`, replacing whatever was there before. */
    async write(ctx: Context, key: string, value: unknown): Promise<void> {
        this.#assertLive(ctx);
        await this.#persistence.writeValue(ctx, `${this.prefix}${key}`, value);
    }

    /**
     * Read, decide, and write, so the value the updater sees is exactly the value it replaces.
     * One store has one owner, so nothing else can write between the read and the write. An
     * updater that throws leaves the stored value untouched.
     */
    async update<Value>(
        ctx: Context,
        key: string,
        updater: (current: unknown) => Value | Promise<Value>,
    ): Promise<Value> {
        this.#assertLive(ctx);
        const full = `${this.prefix}${key}`;
        const entries = await this.#persistence.readValues(ctx, full);
        const current = entries.find((entry) => entry.key === full)?.value;
        const next = await updater(current);
        await this.#persistence.writeValue(ctx, full, next);
        return next;
    }

    /**
     * Return the durable value already stored under `key`, or create and store it exactly once.
     * The read and possible write share one persistence transaction, and an existing outer
     * transaction is reused. A tool can use this on its call-bound KV for retry-stable operation
     * identities without minting another identity for the invocation.
     */
    async getOrCreate<Value>(
        ctx: Context,
        key: string,
        create: () => Value | Promise<Value>,
    ): Promise<Value> {
        this.#assertLive(ctx);
        return await this.#persistence.transaction(ctx, async (txCtx) => {
            const full = `${this.prefix}${key}`;
            const entries = await this.#persistence.readValues(txCtx, full);
            const existing = entries.find((entry) => entry.key === full);
            if (existing !== undefined) return existing.value as Value;
            const value = await create();
            if (await this.#persistence.writeValueIfAbsent(txCtx, full, value)) return value;
            const winner = (await this.#persistence.readValues(txCtx, full)).find(
                (entry) => entry.key === full,
            );
            if (winner === undefined) {
                throw new Error("The durable get-or-create value disappeared before it was read.");
            }
            return winner.value as Value;
        });
    }

    /**
     * Run work as one atomic step of the underlying store: everything it writes commits together,
     * and a thrown error leaves the store exactly as it was. The work is given this same scope and
     * the transaction's context, whose lifetime ends when the work returns, so a transaction
     * cannot be written into after it has committed.
     */
    async transaction<Result>(
        ctx: Context,
        work: (kv: AgentKV, txCtx: Context) => Promise<Result>,
    ): Promise<Result> {
        this.#assertLive(ctx);
        return await this.#persistence.transaction(ctx, async (txCtx) => {
            const committed = new AbortController();
            const liveCtx = withLifetime(txCtx, committed.signal);
            try {
                return await work(this, liveCtx);
            } finally {
                committed.abort();
            }
        });
    }

    /**
     * Remove every entry in this scope, including the ones its narrower scopes wrote. This is how
     * a store whose lifetime has ended is disposed of — the run store when the agent settles — so
     * it runs as one operation of the underlying store and joins a transaction like any other
     * write.
     */
    async clear(ctx: Context): Promise<void> {
        this.#assertLive(ctx);
        const entries = await this.#persistence.readValues(ctx, this.prefix);
        for (const entry of entries) {
            await this.#persistence.deleteValue(ctx, entry.key);
        }
    }

    /** Remove the entry stored under `key`, if any. */
    async delete(ctx: Context, key: string): Promise<void> {
        this.#assertLive(ctx);
        await this.#persistence.deleteValue(ctx, `${this.prefix}${key}`);
    }

    /**
     * Refuse a store operation when either its caller-owned context or this bounded handle has
     * ended. The latter is what makes call KV stay erased even if retained code supplies a fresh
     * unrelated context after commit.
     */
    #assertLive(ctx: Context): void {
        if (ctx.lifetime?.aborted === true || !this.#available()) {
            throw new Error("The store cannot be used: the work its context belongs to has ended.");
        }
    }
}
