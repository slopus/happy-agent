import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Context } from "@steve.kite/stdlib";

import {
    ComputeModule,
    type ComputeSessionActivity,
    type HostCompute,
} from "../../sources/compute/index.js";
import { ConfigModule } from "../../sources/config/index.js";

/**
 * Configuration read from a Happy root of its own.
 *
 * Nothing is written into that root, so every setting is the built-in default and no test reads
 * the settings of whoever is running it. One is enough: it is immutable and says the same thing
 * to every module that asks.
 */
export const testConfig: ConfigModule = await ConfigModule.load(
    await mkdtemp(join(tmpdir(), "happy-modules-")),
);
for (const providerId of testConfig.providerIds) testConfig.setProviderEnabled(providerId, true);

/**
 * A compute module that hands out the machine the test built.
 *
 * Only the lookup is scripted. A module under test still asks this module for permissions, for
 * resolved paths, and for whether a path needs review, and gets the product's real answers.
 */
export function scriptedComputeModule(
    resolve: (ctx: Context, agentId: string) => Promise<HostCompute | undefined>,
): ComputeModule {
    return new ScriptedComputeModule(resolve);
}

class ScriptedComputeModule extends ComputeModule {
    readonly #resolve: (ctx: Context, agentId: string) => Promise<HostCompute | undefined>;

    constructor(resolve: (ctx: Context, agentId: string) => Promise<HostCompute | undefined>) {
        super(testConfig);
        this.#resolve = resolve;
    }

    override async resolve(ctx: Context, agentId: string): Promise<HostCompute | undefined> {
        return await this.#resolve(ctx, agentId);
    }
}

/**
 * A compute module whose running commands are whatever a test says are running.
 *
 * A module that reduces an agent's permission mode has to end what is still running under the
 * wider one, and it asks the module that owns those commands rather than being handed a way to end
 * them. This is that module, with only the two calls that matter scripted: which commands are
 * running, and what happened when one was asked to stop. Everything else is the real module.
 */
export class ScriptedCommandsComputeModule extends ComputeModule {
    /** Every `(agent, command)` pair this module was asked to stop, in order. */
    readonly stopped: { readonly agentId: string; readonly commandId: number }[] = [];
    readonly #running = new Map<string, ComputeSessionActivity[]>();
    /** Thrown instead of listing commands, so a failing cleanup can be observed. */
    listFailure: unknown;

    constructor() {
        super(testConfig);
    }

    /** Say that these command IDs are running for one agent. */
    running(agentId: string, commandIds: readonly number[]): void {
        this.#running.set(
            agentId,
            commandIds.map((sessionId) => ({
                command: `command-${sessionId}`,
                cwd: "/workspace",
                sessionId,
                status: "running" as const,
            })),
        );
    }

    override runningCommands(agentId: string): readonly ComputeSessionActivity[] {
        if (this.listFailure !== undefined) throw this.listFailure;
        return this.#running.get(agentId) ?? [];
    }

    override async stopCommand(agentId: string, commandId: number): Promise<boolean> {
        this.stopped.push({ agentId, commandId });
        const remaining = (this.#running.get(agentId) ?? []).filter(
            (session) => session.sessionId !== commandId,
        );
        this.#running.set(agentId, remaining);
        return true;
    }
}
