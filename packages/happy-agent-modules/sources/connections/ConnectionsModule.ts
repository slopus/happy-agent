import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import type { AgentModule, AgentModuleHooks, AgentModuleScope } from "@slopus/happy-agent-base";
import {
    connectionIdSchema,
    reorderConnectionRequestSchema,
    resourceVersionSchema,
    type Connection,
    type ConnectionsUpdatedPayload,
} from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, asyncLock, detach, withLifetime, type Context } from "@steve.kite/stdlib";

import { BotsModule } from "../bots/index.js";
import { CloudModule } from "../cloud/index.js";
import {
    ConfigModule,
    type RemoteConnectionConfig,
    type RemoteConnectionEntry,
} from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { TailcatModule } from "../tailcat/index.js";
import { RemoteConnectionError } from "./RemoteConnectionError.js";
import { RemoteProxyConnection } from "./impl/RemoteProxyConnection.js";
import { connectionOrderKeyBetween } from "./impl/connectionOrderKey.js";
import {
    listConnectionsTool,
    setConnectionTool,
    removeConnectionTool,
} from "./tools/connectionTools.js";
import { checkConnectionHealthTool } from "./tools/check_remote_connection_health.js";
import type { ConnectionHealth } from "./ConnectionHealth.js";
import { createConnectionVersion } from "./createConnectionVersion.js";
import {
    connectionsMigrations,
    queryConnectionSnapshot,
    saveConnectionSnapshot,
} from "./persistence/connectionSnapshot.js";

/** Machine-owned remote roster, admin tools, and authenticated per-remote HTTP pools. */
export class ConnectionsModule implements AgentModule {
    readonly name = "connections";
    readonly migrations = connectionsMigrations;
    readonly #listeners = new Set<
        (ctx: Context, snapshot: ConnectionsUpdatedPayload, mutationId?: string) => void
    >();
    readonly #config: ConfigModule;
    readonly #bots: BotsModule;
    readonly #cloud: CloudModule;
    readonly #tailcat: TailcatModule;
    readonly #durable: DurableFunctionsModule;
    readonly #lock = asyncLock({ reentry: "block" });
    readonly #pools = new Map<
        string,
        { config: RemoteConnectionConfig; pool: RemoteProxyConnection }
    >();
    #closed = false;
    #ctx: Context | undefined;

    constructor(
        config: ConfigModule,
        bots: BotsModule,
        cloud: CloudModule,
        tailcat: TailcatModule,
        durable: DurableFunctionsModule,
    ) {
        this.#config = config;
        this.#bots = bots;
        this.#cloud = cloud;
        this.#tailcat = tailcat;
        this.#durable = durable;
        durable.register({
            name: "connections-reconcile",
            argumentsSchema: Type.Object({}, { additionalProperties: false }),
            resultSchema: Type.Null(),
            executor: async (ctx) => {
                await this.#reconcile(ctx);
                return null;
            },
        });
    }

    readonly beforeStart = (ctx: Context): AgentModuleHooks => {
        const root = detach(ctx).named("remote-connections");
        this.#ctx = ctx.lifetime === undefined ? root : withLifetime(root, ctx.lifetime);
        return {
            afterStart: this.afterStart,
            tools: async (toolCtx: Context, scope: AgentModuleScope) => {
                if (!(await this.#isAdmin(toolCtx, scope.agent.id))) return [];
                return [
                    listConnectionsTool(this, scope.agent.id),
                    setConnectionTool(this, scope.agent.id),
                    removeConnectionTool(this, scope.agent.id),
                    checkConnectionHealthTool(this, scope.agent.id),
                ];
            },
        };
    };

    readonly afterStart = async (ctx: Context): Promise<void> => {
        await this.getSnapshot(ctx);
        await this.#durable.invoke(ctx, {
            function: "connections-reconcile",
            arguments: {},
            lockKeys: ["connections"],
        });
    };

    get entrySchema() {
        return this.#config.remoteConnectionEntrySchema;
    }

    onUpdated(
        listener: (ctx: Context, snapshot: ConnectionsUpdatedPayload, mutationId?: string) => void,
    ): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /** Reconcile the public projection atomically, participating in the caller's transaction. */
    async getSnapshot(ctx: Context): Promise<ConnectionsUpdatedPayload> {
        return await ctx.inTx(async (txCtx) => {
            const previous = await queryConnectionSnapshot(txCtx);
            const connections = this.#configuredRoster(previous?.connections ?? []);
            if (previous !== undefined && isDeepStrictEqual(previous.connections, connections))
                return previous;
            const snapshot = { connections, version: createConnectionVersion(previous?.version) };
            await this.#saveSnapshot(txCtx, snapshot);
            return snapshot;
        });
    }

    async list(ctx: Context): Promise<Connection[]> {
        return (await this.getSnapshot(ctx)).connections;
    }

    #configuredRoster(previous: readonly Connection[]): Connection[] {
        const keys = new Map(previous.map((connection) => [connection.id, connection.orderKey]));
        const configured = this.#config.connections;
        let lastKey =
            previous
                .filter((connection) => {
                    const entry = Object.hasOwn(configured, connection.id)
                        ? configured[connection.id]
                        : undefined;
                    return entry !== undefined && entry.enabled !== false;
                })
                .at(-1)?.orderKey ?? null;
        return Object.entries(configured)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .flatMap(([id, entry]) => {
                if (entry.enabled === false) return [];
                let orderKey = keys.get(id);
                if (orderKey === undefined) {
                    orderKey = connectionOrderKeyBetween(lastKey, null);
                    lastKey = orderKey;
                }
                return [
                    {
                        id,
                        name: entry.name,
                        orderKey,
                        ...("token" in entry
                            ? { authentication: "bearer" as const }
                            : {
                                  authentication: "workos" as const,
                                  organizationId: entry.workos_organization_id,
                              }),
                    },
                ];
            })
            .sort((left, right) =>
                left.orderKey < right.orderKey
                    ? -1
                    : left.orderKey > right.orderKey
                      ? 1
                      : left.id < right.id
                        ? -1
                        : left.id > right.id
                          ? 1
                          : 0,
            );
    }

    /** Compare-and-swap the shared roster in the caller's transaction; transports are untouched. */
    async reorder(
        ctx: Context,
        id: string,
        afterId: string | null,
        expectedVersion: string,
        mutationId?: string,
    ): Promise<ConnectionsUpdatedPayload> {
        if (
            !Value.Check(connectionIdSchema, id) ||
            !Value.Check(reorderConnectionRequestSchema, { afterId, mutationId }) ||
            !Value.Check(resourceVersionSchema, expectedVersion)
        ) {
            throw new RemoteConnectionError(
                400,
                "invalid_request",
                "Provide a valid connection, destination, and roster version.",
            );
        }
        return await ctx.inTx(async (txCtx) => {
            // Reconciliation is a separate roster transition. A rejected move must return a
            // persisted version, never a freshly reconciled snapshot that its rollback discards.
            const previous = await queryConnectionSnapshot(txCtx);
            if (previous === undefined) {
                throw new RemoteConnectionError(
                    503,
                    "remote_unavailable",
                    "The connection roster is not ready.",
                );
            }
            if (previous.version !== expectedVersion)
                throw new RemoteConnectionError(
                    409,
                    "conflict",
                    "The connections have changed.",
                    previous,
                );
            const currentIndex = previous.connections.findIndex(
                (connection) => connection.id === id,
            );
            const current = previous.connections[currentIndex];
            if (current === undefined)
                throw new RemoteConnectionError(
                    404,
                    "not_found",
                    "The remote connection was not found.",
                );
            if (id === afterId)
                throw new RemoteConnectionError(
                    400,
                    "invalid_request",
                    "A connection cannot be placed after itself.",
                );
            const remaining = previous.connections.filter((connection) => connection.id !== id);
            const afterIndex =
                afterId === null
                    ? -1
                    : remaining.findIndex((connection) => connection.id === afterId);
            if (afterId !== null && afterIndex === -1)
                throw new RemoteConnectionError(
                    404,
                    "not_found",
                    "The destination connection was not found.",
                );
            if (currentIndex === afterIndex + 1) return previous;
            const orderKey = connectionOrderKeyBetween(
                remaining[afterIndex]?.orderKey ?? null,
                remaining[afterIndex + 1]?.orderKey ?? null,
            );
            remaining.splice(afterIndex + 1, 0, { ...current, orderKey });
            const snapshot = {
                connections: remaining,
                version: createConnectionVersion(previous.version),
            };
            await this.#saveSnapshot(txCtx, snapshot, mutationId);
            return snapshot;
        });
    }

    async #saveSnapshot(
        ctx: Context,
        snapshot: ConnectionsUpdatedPayload,
        mutationId?: string,
    ): Promise<void> {
        await saveConnectionSnapshot(ctx, snapshot);
        afterCommit(ctx, (committedCtx) => {
            for (const listener of this.#listeners)
                listener(committedCtx, structuredClone(snapshot), mutationId);
        });
    }

    async listForAdmin(ctx: Context, agentId: string): Promise<Connection[]> {
        await this.#requireAdmin(ctx, agentId);
        return await this.list(ctx);
    }

    async set(
        ctx: Context,
        agentId: string,
        id: string,
        entry: RemoteConnectionEntry,
    ): Promise<Connection[]> {
        await this.#requireAdmin(ctx, agentId);
        return await this.#lock.runInLock(ctx, async () => {
            if (this.#closed)
                throw new RemoteConnectionError(
                    503,
                    "remote_unavailable",
                    "Remote connections have stopped.",
                );
            if (
                Object.hasOwn(this.#config.connections, id) &&
                isDeepStrictEqual(this.#config.connections[id], entry)
            )
                return await this.list(ctx);
            await this.#config.updateRuntimeConnection(ctx, id, entry);
            await this.#reconcilePool(id, entry);
            await this.#durable.invoke(ctx, {
                function: "connections-reconcile",
                arguments: {},
                lockKeys: ["connections"],
            });
            return await this.list(ctx);
        });
    }

    async forward(
        ctx: Context,
        request: IncomingMessage,
        output: ServerResponse | Duplex,
        id: string,
        path: string,
        head?: Buffer,
    ): Promise<void> {
        const record = await this.#getRecord(ctx, id);
        await record.pool.forward(
            request,
            output,
            path,
            async (signal) => {
                if ("token" in record.config) return record.config.token;
                if (this.#config.configuration.values.feature.team.enabled) {
                    // ApiModule has authenticated this exact request, including local onboarding.
                    const authorization = request.headers.authorization;
                    if (authorization === undefined)
                        throw new RemoteConnectionError(401, "unauthorized", "Unauthorized");
                    return authorization.slice("Bearer ".length);
                }
                return await this.#cloud.mintForOrganization(
                    ctx,
                    record.config.workos_organization_id,
                    signal,
                );
            },
            head,
        );
    }

    async checkHealth(ctx: Context, agentId: string, id: string): Promise<ConnectionHealth> {
        await this.#requireAdmin(ctx, agentId);
        const record = await this.#getRecord(ctx, id);
        try {
            return {
                connectionId: id,
                ...(await record.pool.health(async (signal) => {
                    if ("token" in record.config) return record.config.token;
                    return await this.#cloud.mintForOrganization(
                        ctx,
                        record.config.workos_organization_id,
                        signal,
                    );
                })),
            };
        } catch (error) {
            if (error instanceof RemoteConnectionError)
                return {
                    connectionId: id,
                    reachable: false,
                    authenticated: false,
                    ready: false,
                    error: error.message,
                };
            // Cloud owns safe authentication errors; never expose a raw process or HTTP error.
            return {
                connectionId: id,
                reachable: false,
                authenticated: false,
                ready: false,
                error: "The remote health check could not authenticate. Team checks require a connected Cloud account authorized for that organization.",
            };
        }
    }

    async #getRecord(ctx: Context, id: string) {
        return await this.#lock.runInLock(ctx, async () => {
            const configured = this.#config.connections;
            const entry = Object.hasOwn(configured, id) ? configured[id] : undefined;
            if (entry === undefined || entry.enabled === false)
                throw new RemoteConnectionError(
                    404,
                    "not_found",
                    "The remote connection was not found.",
                );
            if (this.#closed)
                throw new RemoteConnectionError(
                    503,
                    "remote_unavailable",
                    "Remote connections have stopped.",
                );
            let current = this.#pools.get(id);
            if (current === undefined) {
                const transport = this.#tailcat.openRemote(entry.address);
                current = {
                    config: entry,
                    pool: new RemoteProxyConnection(
                        () => transport.connect(entry.port ?? 24779),
                        () => transport.close(),
                    ),
                };
                this.#pools.set(id, current);
            }
            return current;
        });
    }

    async close(ctx: Context): Promise<void> {
        await this.#lock.runInLock(ctx, async () => {
            this.#closed = true;
            await Promise.all([...this.#pools.values()].map(({ pool }) => pool.close()));
            this.#pools.clear();
        });
    }

    async #reconcile(ctx: Context): Promise<void> {
        await this.#lock.runInLock(this.#ctx ?? ctx, async () => {
            const configured = this.#config.connections;
            for (const id of this.#pools.keys()) await this.#reconcilePool(id, configured[id]);
            await this.getSnapshot(ctx);
        });
    }

    /** Display metadata never owns the lifetime of a remote's requests or carrier. */
    async #reconcilePool(id: string, entry: RemoteConnectionEntry | undefined): Promise<void> {
        const current = this.#pools.get(id);
        if (current === undefined) return;
        if (entry !== undefined && entry.enabled !== false) {
            const { name: _previousName, ...previousSettings } = current.config;
            const { name: _nextName, ...nextSettings } = entry;
            if (isDeepStrictEqual(previousSettings, nextSettings)) {
                current.config = entry;
                return;
            }
        }
        await current.pool.close();
        this.#pools.delete(id);
    }

    async #isAdmin(ctx: Context, id: string): Promise<boolean> {
        const bot = await this.#bots.forAgent(ctx, id);
        return bot?.isAdmin === true && bot.status === "active";
    }
    async #requireAdmin(ctx: Context, id: string): Promise<void> {
        if (!(await this.#isAdmin(ctx, id)))
            throw new Error("Only an active admin bot can manage remote connections.");
    }
}
