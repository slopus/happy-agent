import type { IncomingMessage, ServerResponse } from "node:http";
import { connect as connectTcp, isIP } from "node:net";
import type { Duplex } from "node:stream";
import { connect as connectTls } from "node:tls";
import { isDeepStrictEqual } from "node:util";
import {
    withAgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
} from "@slopus/happy-agent-base";
import {
    connectionIdSchema,
    isHappyErrorBody,
    reorderConnectionRequestSchema,
    resourceVersionSchema,
    type Connection,
    type ConnectionsUpdatedPayload,
    type HealthResponse,
} from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, asyncLock, detach, withLifetime, type Context } from "@steve.kite/stdlib";

import { BotsModule } from "../bots/index.js";
import { CloudModule, CloudOperationError } from "../cloud/index.js";
import {
    ConfigModule,
    type RemoteConnectionConfig,
    type RemoteConnectionEntry,
} from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { TailcatModule } from "../tailcat/index.js";
import { RemoteConnectionError } from "./RemoteConnectionError.js";
import {
    RemoteProxyConnection,
    type RemoteProxyAnswer,
    type RemoteProxyExchange,
    type RemoteProxyReplacement,
} from "./impl/RemoteProxyConnection.js";
import { normalizeServerUrl } from "./impl/normalizeServerUrl.js";
import { openRemoteWebSocketTunnel } from "./impl/openRemoteWebSocketTunnel.js";
import { serverConnectionId } from "./impl/serverConnectionId.js";
import {
    readServerHealth,
    remoteSignInRequired,
    requireServerSignIn,
    serverAcceptsToken,
} from "./impl/serverRequests.js";
import { logSlowRemoteRequest } from "./impl/logSlowRemoteRequest.js";
import { connectionOrderKeyBetween } from "./impl/connectionOrderKey.js";
import {
    addServerConnectionTool,
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
import {
    queryReservedServerConnectionIds,
    reserveServerConnectionId,
} from "./persistence/reservedServerConnectionIds.js";

/** How long a server connection's event stream or WebSocket may stay silent. */
const SERVER_IDLE_MS = 45_000;

/** A connection's open pool. A server pool also keeps the URL its pool was built for. */
interface ConnectionRecord {
    config: RemoteConnectionConfig;
    readonly url?: string;
    readonly pool: RemoteProxyConnection;
}

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
    /** Whether each server connection by URL carries tunnels, from the health it last relayed. */
    readonly #webSocketTunnels = new Map<string, boolean>();
    /** Connections whose endpoint changed, whose remembered identity no longer applies. */
    readonly #staleInstanceIds = new Set<string>();
    readonly #lock = asyncLock({ reentry: "block" });
    readonly #pools = new Map<string, ConnectionRecord>();
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
        // Identities learned in the background are saved through the module's own context.
        const root = withAgentDatabase(detach(ctx).named("remote-connections"), ctx.db);
        this.#ctx = ctx.lifetime === undefined ? root : withLifetime(root, ctx.lifetime);
        return {
            afterStart: this.afterStart,
            tools: async (toolCtx: Context, scope: AgentModuleScope) => {
                if (!(await this.#isAdmin(toolCtx, scope.agent.id))) return [];
                return [
                    listConnectionsTool(this, scope.agent.id),
                    setConnectionTool(this, scope.agent.id),
                    addServerConnectionTool(this, scope.agent.id),
                    removeConnectionTool(this, scope.agent.id),
                    checkConnectionHealthTool(this, scope.agent.id),
                ];
            },
        };
    };

    readonly afterStart = async (ctx: Context): Promise<void> => {
        this.#refreshTeamTokensAhead();
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
            afterCommit(txCtx, () => this.#staleInstanceIds.clear());
            return snapshot;
        });
    }

    async list(ctx: Context): Promise<Connection[]> {
        return (await this.getSnapshot(ctx)).connections;
    }

    #configuredRoster(previous: readonly Connection[]): Connection[] {
        const keys = new Map(previous.map((connection) => [connection.id, connection.orderKey]));
        const instanceIds = new Map(
            previous.flatMap((connection) =>
                connection.instanceId === undefined ? [] : [[connection.id, connection.instanceId]],
            ),
        );
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
                const instanceId = this.#staleInstanceIds.has(id) ? undefined : instanceIds.get(id);
                const connection: Connection =
                    "token" in entry
                        ? { id, name: entry.name, orderKey, authentication: "bearer" }
                        : "url" in entry
                          ? {
                                id,
                                name: entry.name,
                                orderKey,
                                authentication: "oauth",
                                url: entry.url,
                            }
                          : {
                                id,
                                name: entry.name,
                                orderKey,
                                authentication: "workos",
                                organizationId: entry.workos_organization_id,
                            };
                return [instanceId === undefined ? connection : { ...connection, instanceId }];
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
            const previousEntry = this.#config.connections[id];
            const reserved = await ctx.inTx(async (txCtx) => {
                if (previousEntry !== undefined && "url" in previousEntry)
                    await reserveServerConnectionId(txCtx, id);
                return (await queryReservedServerConnectionIds(txCtx)).has(id);
            });
            entry = serverEntryForSet(previousEntry, entry, reserved);
            if (previousEntry !== undefined && !sameEndpoint(previousEntry, entry)) {
                this.#staleInstanceIds.add(id);
            }
            await this.#config.updateRuntimeConnection(ctx, id, entry);
            this.#refreshTeamTokensAhead();
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
        const startedAt = performance.now();
        let tokenMs = 0;
        let exchange: RemoteProxyExchange | undefined;
        let status = 500;
        try {
            const record = await this.#getRecord(ctx, id);
            if ("url" in record.config) {
                exchange = await this.#forwardToServer(request, output, id, record, path, head);
                status = exchange.status ?? 502;
                return;
            }
            exchange = await record.pool.forward(
                request,
                output,
                path,
                async (signal) => {
                    const tokenStartedAt = performance.now();
                    try {
                        return await this.#authorize(ctx, request, id, record.config, signal);
                    } finally {
                        tokenMs = performance.now() - tokenStartedAt;
                    }
                },
                head,
            );
            status = exchange.status ?? 502;
        } catch (error) {
            if (error instanceof RemoteConnectionError || error instanceof CloudOperationError)
                status = error.status;
            throw error;
        } finally {
            logSlowRemoteRequest(ctx, {
                connectionId: id,
                method: request.method,
                path,
                status,
                startedAt,
                finishedAt: performance.now(),
                tokenMs,
                exchange,
            });
        }
    }

    async #authorize(
        ctx: Context,
        request: IncomingMessage,
        id: string,
        config: RemoteConnectionConfig,
        signal: AbortSignal,
    ): Promise<string> {
        if ("token" in config) return config.token;
        if ("url" in config) return remoteToken(request);
        if (this.#config.configuration.values.feature.team.enabled) {
            // ApiModule has authenticated this exact request, including local onboarding.
            const authorization = request.headers.authorization;
            if (authorization === undefined)
                throw new RemoteConnectionError(401, "unauthorized", "Unauthorized");
            return authorization.slice("Bearer ".length);
        }
        return await this.#cloud.mintForOrganization(ctx, config.workos_organization_id, signal);
    }

    /** Cloud refreshes ahead only the team tokens an enabled remote mints for. */
    #refreshTeamTokensAhead(): void {
        const organizationIds =
            this.#closed || this.#config.configuration.values.feature.team.enabled
                ? []
                : Object.values(this.#config.connections).flatMap((entry) =>
                      entry.enabled !== false && "workos_organization_id" in entry
                          ? [entry.workos_organization_id]
                          : [],
                  );
        this.#cloud.refreshOrganizationsAhead(organizationIds);
    }

    async checkHealth(ctx: Context, agentId: string, id: string): Promise<ConnectionHealth> {
        await this.#requireAdmin(ctx, agentId);
        const record = await this.#getRecord(ctx, id);
        try {
            return {
                connectionId: id,
                ...(await record.pool.health(async (signal) => {
                    if ("token" in record.config) return record.config.token;
                    if ("url" in record.config) {
                        throw new RemoteConnectionError(
                            403,
                            "remote_sign_in_required",
                            "This daemon holds no sign-in for a server connection by URL; each person's app signs in to it.",
                        );
                    }
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
                const onHealth = (health: HealthResponse) => this.#observeHealth(id, health);
                if ("url" in entry) {
                    current = {
                        config: entry,
                        url: entry.url,
                        pool: this.#serverPool(id, entry.url, onHealth),
                    };
                } else {
                    const transport = this.#tailcat.openRemote(entry.address);
                    current = {
                        config: entry,
                        pool: new RemoteProxyConnection(
                            () => transport.connect(entry.port ?? 24779),
                            () => transport.close(),
                            { onHealth },
                        ),
                    };
                }
                this.#pools.set(id, current);
            }
            return current;
        });
    }

    async close(ctx: Context): Promise<void> {
        await this.#lock.runInLock(ctx, async () => {
            this.#closed = true;
            this.#refreshTeamTokensAhead();
            await Promise.all([...this.#pools.values()].map(({ pool }) => pool.close()));
            this.#pools.clear();
        });
    }

    async #reconcile(ctx: Context): Promise<void> {
        await this.#lock.runInLock(this.#ctx ?? ctx, async () => {
            const configured = this.#config.connections;
            this.#refreshTeamTokensAhead();
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
        this.#webSocketTunnels.delete(id);
    }

    /** Add a server connection by URL for an admin bot. It never holds a token for it. */
    async addServer(
        ctx: Context,
        agentId: string,
        url: string,
        name?: string,
    ): Promise<Connection[]> {
        await this.#requireAdmin(ctx, agentId);
        if (this.#config.configuration.values.feature.team.enabled) {
            throw new Error(
                "A server connection by URL can be added only on a personal Happy Agent.",
            );
        }
        const normalized = normalizeServerUrl(url);
        if (normalized === undefined) {
            throw new Error("Use an https:// address without a user name, query, or fragment.");
        }
        const entry = { name: name ?? new URL(normalized).hostname, url: normalized };
        if (!Value.Check(this.entrySchema, entry)) throw new Error("The server name is invalid.");
        return await this.#lock.runInLock(ctx, async () => {
            if (this.#closed)
                throw new RemoteConnectionError(
                    503,
                    "remote_unavailable",
                    "Remote connections have stopped.",
                );
            const configured = this.#config.connections;
            const existing = Object.entries(configured).find(
                ([, candidate]) => "url" in candidate && candidate.url === normalized,
            );
            if (existing !== undefined) {
                throw new Error(`That server is already connected as ${existing[0]}.`);
            }
            if (Object.keys(configured).length >= 100) {
                throw new Error("At most 100 remote connections can be added.");
            }
            await requireServerSignIn(normalized);
            const instanceId = (await readServerHealth(normalized))?.instanceId;
            const id = await ctx.inTx(async (txCtx) => {
                const taken = await queryReservedServerConnectionIds(txCtx);
                for (const key of Object.keys(configured)) taken.add(key);
                const id = serverConnectionId(normalized, taken);
                await reserveServerConnectionId(txCtx, id);
                return id;
            });
            await this.#config.updateRuntimeConnection(ctx, id, entry);
            await ctx.inTx(async (txCtx) => {
                const previous = await queryConnectionSnapshot(txCtx);
                const connections = this.#configuredRoster(previous?.connections ?? []).map(
                    (connection) =>
                        connection.id === id && instanceId !== undefined
                            ? { ...connection, instanceId }
                            : connection,
                );
                await this.#saveSnapshot(txCtx, {
                    connections,
                    version: createConnectionVersion(previous?.version),
                });
            });
            await this.#durable.invoke(ctx, {
                function: "connections-reconcile",
                arguments: {},
                lockKeys: ["connections"],
            });
            return await this.list(ctx);
        });
    }

    /**
     * Proxy one request to a server connection by URL with the person's own token from
     * `Happy-Remote-Authorization`, applying the sign-in rule. Nothing is stored or replayed.
     */
    async #forwardToServer(
        request: IncomingMessage,
        output: ServerResponse | Duplex,
        id: string,
        record: ConnectionRecord,
        path: string,
        head: Buffer | undefined,
    ): Promise<RemoteProxyExchange> {
        // The token goes only through the record whose URL was resolved for this request, never
        // through whatever the ID names by the time it is sent.
        if (!("url" in record.config) || record.url !== record.config.url) {
            throw new RemoteConnectionError(
                404,
                "not_found",
                "The remote connection was not found.",
            );
        }
        const url = record.url;
        const token = remoteToken(request);
        const tunnel = head !== undefined && request.method === "CONNECT";
        const twin = head !== undefined && /\/websocket(?:\?|$)/u.test(path);
        if (tunnel || twin) {
            let carries = this.#webSocketTunnels.get(id);
            if (carries === undefined) {
                const health = await readServerHealth(url, token);
                if (health !== undefined) this.#observeHealth(id, health);
                carries = health?.capabilities?.webSocketTunnels === true;
            }
            if (!carries) {
                throw new RemoteConnectionError(
                    501,
                    "unsupported",
                    "This server cannot carry browser previews or tunnels through its address yet.",
                );
            }
        }
        if (tunnel) {
            return await openRemoteWebSocketTunnel({
                url: webSocketUrl(url, `${path.split("?")[0] ?? path}/websocket`),
                token,
                client: output as Duplex,
                head,
                idleMs: SERVER_IDLE_MS,
                screen: (answer, used) => this.#screen(url, answer, used),
                signal: new AbortController().signal,
            });
        }
        return await record.pool.forward(request, output, path, async () => token, head);
    }

    /** The sign-in rule, applied to a remote answer the client must never see as its own. */
    async #screen(
        url: string,
        answer: RemoteProxyAnswer,
        token: string,
    ): Promise<RemoteProxyReplacement | undefined> {
        let body: unknown;
        try {
            body = answer.body === undefined ? undefined : JSON.parse(answer.body.toString("utf8"));
        } catch {
            body = undefined;
        }
        const happy = isHappyErrorBody(answer.contentType, body);
        if (answer.status === 403 && happy) return undefined;
        if (
            answer.status === 401 &&
            happy &&
            (await serverAcceptsToken(url, token).catch(() => false))
        ) {
            return undefined;
        }
        const error = remoteSignInRequired();
        return { status: error.status, body: { error: error.message, code: error.code } };
    }

    #serverPool(
        id: string,
        url: string,
        onHealth: (health: HealthResponse) => void,
    ): RemoteProxyConnection {
        const target = new URL(url);
        const secure = target.protocol === "https:";
        const host = target.hostname.replace(/^\[|\]$/gu, "");
        const port = Number(target.port === "" ? (secure ? 443 : 80) : target.port);
        return new RemoteProxyConnection(
            () =>
                secure
                    ? connectTls({
                          host,
                          port,
                          ALPNProtocols: ["http/1.1"],
                          ...(isIP(host) === 0 ? { servername: host } : {}),
                      })
                    : connectTcp({ host, port }),
            undefined,
            {
                target: { host: target.host, pathPrefix: target.pathname.replace(/\/$/u, "") },
                screen: (answer, token) => this.#screen(url, answer, token),
                idleMs: SERVER_IDLE_MS,
                onHealth,
            },
        );
    }

    /** Remember a remote's identity, from any health response the daemon read or relayed. */
    #observeHealth(id: string, health: HealthResponse): void {
        const config = this.#pools.get(id)?.config;
        if (config !== undefined && "url" in config) {
            this.#webSocketTunnels.set(id, health.capabilities?.webSocketTunnels === true);
        }
        if (health.instanceId !== undefined) void this.#learnInstanceId(id, health.instanceId);
    }

    async #learnInstanceId(id: string, instanceId: string): Promise<void> {
        const ctx = this.#ctx;
        if (ctx === undefined || this.#closed) return;
        await ctx
            .inTx(async (txCtx) => {
                const previous = await queryConnectionSnapshot(txCtx);
                if (previous === undefined) return;
                const current = previous.connections.find((connection) => connection.id === id);
                if (current === undefined || current.instanceId === instanceId) return;
                await this.#saveSnapshot(txCtx, {
                    connections: previous.connections.map((connection) =>
                        connection.id === id ? { ...connection, instanceId } : connection,
                    ),
                    version: createConnectionVersion(previous.version),
                });
            })
            .catch((error: unknown) => {
                ctx.log.warn(
                    "Could not remember a remote's identity.",
                    { connectionId: id },
                    error,
                );
            });
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

/**
 * A server connection by URL keeps its address for life. Apps keep each person's token by
 * connection ID and the proxy forwards it to the entry's URL, so pointing an existing ID at another
 * address would send one server's token to another. Only `add_server_connection` creates one, after
 * checking its discovery and under a fresh ID; here it may only be renamed or removed, and nothing
 * else may take over its ID while it is enabled.
 */
function serverEntryForSet(
    previous: RemoteConnectionEntry | undefined,
    entry: RemoteConnectionEntry,
    reserved: boolean,
): RemoteConnectionEntry {
    const previousUrl =
        previous !== undefined && previous.enabled !== false && "url" in previous
            ? previous.url
            : undefined;
    if ("url" in entry) {
        if (previousUrl === undefined || normalizeServerUrl(entry.url) !== previousUrl) {
            throw new Error(
                "A server connection by URL is added only with add_server_connection, and its address never changes. Remove it and add the new address instead.",
            );
        }
        return { ...entry, url: previousUrl };
    }
    if (previousUrl !== undefined && entry.enabled !== false) {
        throw new Error(
            "This ID names a server connection by URL. Add the other connection under a new ID.",
        );
    }
    if (reserved && entry.enabled !== false) {
        throw new Error(
            "This ID named a server connection by URL and is never reused. Add the connection under a new ID.",
        );
    }
    return entry;
}

/** Whether two entries reach the same remote the same way; only the display name may differ. */
function sameEndpoint(left: RemoteConnectionEntry, right: RemoteConnectionEntry): boolean {
    if (left.enabled === false || right.enabled === false) return false;
    const { name: _left, ...leftSettings } = left;
    const { name: _right, ...rightSettings } = right;
    return isDeepStrictEqual(leftSettings, rightSettings);
}

/** The WebSocket URL of a remote path under a server URL. */
function webSocketUrl(serverUrl: string, path: string): string {
    const url = new URL(path.replace(/^\/+/u, ""), serverUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
}

/** The person's token for a server connection by URL, from `Happy-Remote-Authorization`. */
function remoteToken(request: IncomingMessage): string {
    const value = request.headers["happy-remote-authorization"];
    const match = typeof value === "string" ? /^Bearer ([^\s]+)$/u.exec(value) : null;
    if (match?.[1] === undefined) throw remoteSignInRequired();
    return match[1];
}
