import {
    agentDatabaseRows,
    ensureAgentDatabaseConnection,
    type AgentModuleHooks,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { expect, vi } from "vitest";

import { DurableFunctionsModule } from "../../../sources/durableFunctions/DurableFunctionsModule.js";
import { moduleDatabase, type ModuleDatabase } from "../../support/moduleDatabase.js";
import { resolveModuleHooks } from "../../support/moduleHooks.js";

const agents = {} as AgentSystemRef;

export interface DurableFunctionsHarness {
    readonly database: ModuleDatabase;
    readonly hooks: AgentModuleHooks;
    readonly module: DurableFunctionsModule;
    readonly start: () => Promise<void>;
    readonly close: () => void;
}

export async function durableFunctionsHarness(
    name: string,
    options: {
        readonly database?: ModuleDatabase;
        readonly module?: DurableFunctionsModule;
        readonly start?: boolean;
    } = {},
): Promise<DurableFunctionsHarness> {
    const module = options.module ?? new DurableFunctionsModule();
    const database = options.database ?? moduleDatabase(module.migrations, name);
    // Production Agent Databases have one FIFO owner. Durable Functions deliberately relies on
    // that owner instead of introducing another database lock with an inverted acquisition order.
    ensureAgentDatabaseConnection(database.database);
    await database.ready;
    const hooks = await resolveModuleHooks(database.context, module, agents);
    const start = async (): Promise<void> => {
        await hooks.afterStart?.(database.context, agents);
    };
    if (options.start !== false) await start();
    return {
        database,
        hooks,
        module,
        start,
        close: () => {
            module.stop();
            if (options.database === undefined) database.close();
        },
    };
}

export function deferred<Value = void>(): {
    readonly promise: Promise<Value>;
    readonly resolve: (value: Value) => void;
    readonly reject: (error: unknown) => void;
} {
    let resolve!: (value: Value) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

export async function waitForCondition(check: () => boolean | Promise<boolean>): Promise<void> {
    await vi.waitFor(async () => {
        expect(await check()).toBe(true);
    });
}

export async function pendingCallCount(ctx: Context): Promise<number> {
    const rows = await agentDatabaseRows<{ readonly count: number }>(
        ctx.db,
        sql`SELECT COUNT(*) AS count FROM durable_function_calls`,
    );
    return rows[0]?.count ?? 0;
}

export async function durableStateCount(ctx: Context): Promise<number> {
    const rows = await agentDatabaseRows<{ readonly count: number }>(
        ctx.db,
        sql`SELECT COUNT(*) AS count FROM durable_function_kv`,
    );
    return rows[0]?.count ?? 0;
}
