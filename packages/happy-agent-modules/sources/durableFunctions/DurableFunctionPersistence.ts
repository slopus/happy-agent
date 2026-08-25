import type { AgentDatabase, AgentPersistence, AgentRecord } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { DurableFunctionsStore } from "./DurableFunctionsStore.js";

/** The AgentKV persistence seam backed by Durable Functions' own key-value table. */
export class DurableFunctionPersistence implements AgentPersistence {
    readonly database: AgentDatabase;
    readonly #store: DurableFunctionsStore;

    constructor(database: AgentDatabase, store: DurableFunctionsStore) {
        this.database = database;
        this.#store = store;
    }

    async transaction<Result>(
        ctx: Context,
        work: (ctx: Context) => Promise<Result>,
    ): Promise<Result> {
        return await ctx.inTx(work);
    }

    load(_ctx: Context): Promise<readonly AgentRecord[]> {
        throw new Error("Durable function state has no record store.");
    }

    append(_ctx: Context, _record: AgentRecord): Promise<void> {
        throw new Error("Durable function state has no record store.");
    }

    clearRecords(_ctx: Context): Promise<void> {
        throw new Error("Durable function state has no record store.");
    }

    async readValues(
        ctx: Context,
        prefix: string,
    ): Promise<readonly { readonly key: string; readonly value: unknown }[]> {
        return await this.#store.readValues(ctx, prefix);
    }

    async writeValue(ctx: Context, key: string, value: unknown): Promise<void> {
        await this.#store.writeValue(ctx, key, value);
    }

    async writeValueIfAbsent(ctx: Context, key: string, value: unknown): Promise<boolean> {
        return await this.#store.writeValueIfAbsent(ctx, key, value);
    }

    async deleteValue(ctx: Context, key: string): Promise<void> {
        await this.#store.deleteValue(ctx, key);
    }
}
