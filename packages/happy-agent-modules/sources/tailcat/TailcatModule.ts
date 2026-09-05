import {
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { asyncLock, detach, withLifetime, type AsyncLock, type Context } from "@steve.kite/stdlib";

import { BotsModule } from "../bots/index.js";
import { ConfigModule } from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import {
    tailcatStatusSchema,
    tailcatTransportTargetSchema,
    type TailcatState,
    type TailcatStatus,
    type TailcatTransportTarget,
} from "./Tailcat.js";
import { startTailcatExposure, type TailcatExposure } from "./impl/startTailcatExposure.js";
import { getTailcatStatusTool } from "./tools/get_tailcat_status.js";
import { setTailcatEnabledTool } from "./tools/set_tailcat_enabled.js";
import { TailcatConnection } from "./impl/TailcatConnection.js";
import { resolveTailcatExecutable } from "./impl/resolveTailcatExecutable.js";
import { tailcatAddressSchema } from "./Tailcat.js";

const TAILCAT_RECONCILE_FUNCTION = "tailcat-reconcile";
const TAILCAT_RECONCILE_LOCK = "tailcat-exposure";
const tailcatReconcileArgumentsSchema = Type.Object({}, { additionalProperties: false });

/** Owns the stable Tailcat identity, supervised process, live state, and admin-only tools. */
export class TailcatModule implements AgentModule {
    readonly name = "tailcat";

    readonly #bots: BotsModule;
    readonly #config: ConfigModule;
    readonly #durableFunctions: DurableFunctionsModule;
    readonly #lock: AsyncLock = asyncLock({ reentry: "block" });
    #closed = false;
    #context: Context | undefined;
    #error: string | undefined;
    #exposure: TailcatExposure | undefined;
    #state: TailcatState;
    #target: TailcatTransportTarget | undefined;
    readonly #outbound = new Set<TailcatConnection>();

    /** Open an outgoing carrier without enabling this installation's inbound exposure. */
    openRemote(address: string): TailcatConnection {
        if (this.#closed || !Value.Check(tailcatAddressSchema, address)) {
            throw new Error("The remote Tailcat connection is unavailable.");
        }
        const connection = new TailcatConnection(resolveTailcatExecutable(), address, () =>
            this.#outbound.delete(connection),
        );
        this.#outbound.add(connection);
        return connection;
    }

    constructor(config: ConfigModule, bots: BotsModule, durableFunctions: DurableFunctionsModule) {
        this.#bots = bots;
        this.#config = config;
        this.#durableFunctions = durableFunctions;
        this.#state = config.tailcatEnabled ? "starting" : "disabled";
        durableFunctions.register({
            name: TAILCAT_RECONCILE_FUNCTION,
            argumentsSchema: tailcatReconcileArgumentsSchema,
            resultSchema: Type.Null(),
            executor: async (ctx) => {
                await this.#reconcile(ctx);
                return null;
            },
        });
    }

    readonly #hooks: AgentModuleHooks = {
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            if (!(await this.#isActiveAdminBot(ctx, scope.agent.id))) return [];
            return [
                setTailcatEnabledTool(this, scope.agent.id),
                getTailcatStatusTool(this, scope.agent.id),
            ];
        },
    };

    readonly beforeStart = (ctx: Context): AgentModuleHooks => {
        const detached = detach(ctx).named("tailcat");
        this.#context =
            ctx.lifetime === undefined ? detached : withLifetime(detached, ctx.lifetime);
        return this.#hooks;
    };

    /** Supply the API transport once it has bound, opening the configured exposure before return. */
    async attachTransport(ctx: Context, target: TailcatTransportTarget): Promise<TailcatStatus> {
        if (!Value.Check(tailcatTransportTargetSchema, target)) {
            throw new Error("The Tailcat API transport target is invalid.");
        }
        return await this.#lock.runInLock(this.#moduleContext(ctx), async () => {
            if (this.#closed) throw new Error("Tailcat has already stopped.");
            if (this.#target !== undefined && !sameTarget(this.#target, target)) {
                throw new Error("Tailcat is already attached to another API transport.");
            }
            this.#target = structuredClone(target);
            return await this.#reconcileLocked(ctx);
        });
    }

    /** Persist the desired state, durably schedule convergence, and reconcile it immediately. */
    async setEnabled(
        ctx: Context,
        actingAgentId: string,
        enabled: boolean,
    ): Promise<TailcatStatus> {
        await this.#requireActiveAdminBot(ctx, actingAgentId, "manage");
        return await this.#lock.runInLock(this.#moduleContext(ctx), async () => {
            await this.#config.updateRuntimeTailcatEnabled(ctx, enabled);
            await this.#durableFunctions.invoke(ctx, {
                function: TAILCAT_RECONCILE_FUNCTION,
                arguments: {},
                lockKeys: [TAILCAT_RECONCILE_LOCK],
            });
            return await this.#reconcileLocked(ctx);
        });
    }

    /** Read live exposure state after independently checking the captured tool caller. */
    async getStatus(ctx: Context, actingAgentId: string): Promise<TailcatStatus> {
        await this.#requireActiveAdminBot(ctx, actingAgentId, "inspect");
        return this.currentStatus();
    }

    /** Internal daemon snapshot used by its existing programmatic startup result. */
    currentStatus(): TailcatStatus {
        const status: TailcatStatus = {
            enabled: this.#config.tailcatEnabled,
            state: this.#state,
            ...(this.#exposure === undefined
                ? {}
                : { address: this.#exposure.address, port: this.#exposure.port }),
            ...(this.#error === undefined ? {} : { error: this.#error }),
        };
        if (!Value.Check(tailcatStatusSchema, status)) {
            throw new Error("Tailcat produced an invalid live status.");
        }
        return structuredClone(status);
    }

    /** Stop only live work; the persisted enablement remains the next startup's desired state. */
    async close(ctx: Context): Promise<void> {
        await this.#lock.runInLock(this.#moduleContext(ctx), async () => {
            if (this.#closed) return;
            this.#closed = true;
            const outbound = [...this.#outbound];
            await Promise.all(outbound.map((connection) => connection.close()));
            const exposure = this.#exposure;
            this.#exposure = undefined;
            if (exposure !== undefined) await exposure.close();
        });
    }

    async #reconcile(ctx: Context): Promise<TailcatStatus> {
        return await this.#lock.runInLock(
            this.#moduleContext(ctx),
            async () => await this.#reconcileLocked(ctx),
        );
    }

    /** Reconcile while the caller owns this module's one live-state lock. */
    async #reconcileLocked(ctx: Context): Promise<TailcatStatus> {
        if (this.#closed) return this.currentStatus();
        if (!this.#config.tailcatEnabled) {
            const exposure = this.#exposure;
            if (exposure !== undefined) {
                this.#state = "stopping";
                await exposure.close();
                this.#exposure = undefined;
            }
            this.#state = "disabled";
            this.#error = undefined;
            return this.currentStatus();
        }
        if (this.#exposure !== undefined) {
            this.#state = "open";
            this.#error = undefined;
            return this.currentStatus();
        }
        if (this.#target === undefined) {
            this.#state = "starting";
            return this.currentStatus();
        }

        this.#state = "starting";
        this.#error = undefined;
        try {
            const paths = this.#config.configuration.paths;
            this.#exposure = await startTailcatExposure(
                this.#moduleContext(ctx),
                this.#target,
                {
                    addressPath: paths.tailcatAddressPath,
                    home: paths.tailcatHome,
                    keyPath: paths.tailcatKeyPath,
                    portPath: paths.tailcatPortPath,
                },
                this.#config.tailcatPort,
            );
            this.#state = "open";
            return this.currentStatus();
        } catch (error: unknown) {
            this.#exposure = undefined;
            this.#state = "failed";
            this.#error = errorMessage(error);
            throw error;
        }
    }

    async #isActiveAdminBot(ctx: Context, agentId: string): Promise<boolean> {
        const bot = await this.#bots.forAgent(ctx, agentId);
        return bot?.isAdmin === true && bot.status === "active";
    }

    async #requireActiveAdminBot(
        ctx: Context,
        agentId: string,
        action: "inspect" | "manage",
    ): Promise<void> {
        if (await this.#isActiveAdminBot(ctx, agentId)) return;
        throw new Error(`Only an active admin bot can ${action} Tailcat internet exposure.`);
    }

    #moduleContext(fallback: Context): Context {
        return this.#context ?? fallback;
    }
}

function sameTarget(left: TailcatTransportTarget, right: TailcatTransportTarget): boolean {
    if ("socketPath" in left || "socketPath" in right) {
        return (
            "socketPath" in left && "socketPath" in right && left.socketPath === right.socketPath
        );
    }
    return left.host === right.host && left.port === right.port;
}

function errorMessage(error: unknown): string {
    const value = error instanceof Error ? error.message : String(error);
    return value.trim().slice(0, 8_192) || "Tailcat failed without an error message.";
}
