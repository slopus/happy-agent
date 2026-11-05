import { createHash, randomBytes } from "node:crypto";

import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { sql } from "drizzle-orm";
import {
    agentDatabase,
    agentDatabaseRun,
    withAgentDatabase,
    type AgentDatabase,
    type AgentModuleAgentLifecycle,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentModuleSystemScope,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { asyncLock, detach, type AsyncLock, type Context } from "@steve.kite/stdlib";

import { ComputeModule } from "../compute/index.js";
import { ConfigModule, type HappyAgentConfigValues } from "../config/index.js";
import { RunnersModule } from "../runners/index.js";
import { UserInputModule } from "../userInput/index.js";
import { WorkspacesModule } from "../workspaces/index.js";

import {
    MAX_MCP_PAGE_SIZE,
    MAX_MCP_CURSOR_LENGTH,
    MAX_MCP_OUTPUT_CHARACTERS,
    MIN_MCP_OUTPUT_CHARACTERS,
    MAX_MCP_TOTAL_TOOLS,
    mcpIndexedServerSchema,
    mcpCallToolInputSchema,
    mcpGetPromptInputSchema,
    mcpGetPromptResultSchema,
    mcpPromptPageSchema,
    mcpPromptPageQuerySchema,
    mcpReadResourceInputSchema,
    mcpReadResourceResultSchema,
    mcpResourcePageQuerySchema,
    mcpResourcePageSchema,
    mcpResourceTemplatePageSchema,
    mcpServerPageQuerySchema,
    mcpServerPageSchema,
    mcpToolPolicySchema,
    mcpToolPageQuerySchema,
    mcpToolPageSchema,
    mcpToolSchema,
    mcpToolResultSchema,
    mcpAgentIdSchema,
    MAX_MCP_ERROR_MESSAGE_LENGTH,
    MAX_MCP_SERVER_NAME_LENGTH,
    type McpAuthResult,
    type McpCallToolInput,
    type McpGetPromptInput,
    type McpGetPromptResult,
    type McpPermissionMode,
    type McpPromptPage,
    type McpPromptPageQuery,
    type McpReadResourceInput,
    type McpReadResourceResult,
    type McpResourcePage,
    type McpResourcePageQuery,
    type McpResourceTemplatePage,
    type McpServerPage,
    type McpServerPageQuery,
    type McpServerSummary,
    type McpIndexedServer,
    type McpTool,
    type McpToolPage,
    type McpToolPageQuery,
    type McpToolPolicy,
    type McpToolResult,
    type McpUserInputRequest,
    type McpUserInputResponse,
} from "./Mcp.js";
import { hasConfiguredAuthorization, McpClientConnection } from "./McpClientConnection.js";
import { beginMcpLogin, McpLoginError } from "./impl/beginMcpLogin.js";
import { McpLoginCallback } from "./impl/McpLoginCallback.js";
import { McpLoginSession, type McpLoginClient } from "./impl/McpLoginSession.js";
import {
    mcpLoginKeyId,
    mcpLoginMigration,
    readMcpLogins,
    writeMcpLogin,
    type McpLogin,
    type McpLoginKey,
} from "./impl/McpLoginStore.js";
import { McpNeedsAuthError } from "./impl/McpNeedsAuthError.js";
import { createMcpConfigurationTools } from "./createMcpConfigurationTools.js";
import { createMcpProtocolTools } from "./createMcpProtocolTools.js";
import { createMcpTool } from "./createMcpTool.js";
import { handleMcpElicitation, type McpUserInputService } from "./handleMcpElicitation.js";
import { humanizeMcpName } from "./humanizeMcpName.js";
import {
    assertPromptPage,
    assertResourcePage,
    assertResourceTemplatePage,
    assertServerPage,
    assertToolPage,
} from "./mcpPageAssertions.js";
import { listMcpServersTool } from "./tools/list_mcp_servers.js";
import { startMcpAuthTool } from "./tools/start_mcp_auth.js";
import { mcpResultToContentBlocks } from "./mcpResultToContentBlocks.js";
import { mergeMcpTools } from "./mergeMcpTools.js";
import { mcpConnectionFingerprint } from "./mcpConnectionFingerprint.js";

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_OUTPUT_CHARACTERS = 12_000;
/**
 * The user-wide catalog as it applies on this machine. Its stdio servers run here; each runner with
 * active agents gets its own copy (`runnerGlobalCatalog`) whose stdio servers run on that runner.
 */
const GLOBAL_CATALOG = "global";
/**
 * The catalog of logins made for user-wide servers. HTTP servers are reached from this machine, so
 * every copy of the user-wide catalog shares them.
 */
const USER_LOGIN_CATALOG = "user";
/** A failed server is retried after this delay, doubling while it keeps failing. */
const RETRY_FIRST_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 5 * 60_000;
const outputCharactersSchema = Type.Integer({
    minimum: MIN_MCP_OUTPUT_CHARACTERS,
    maximum: MAX_MCP_OUTPUT_CHARACTERS,
});

const mcpMigration = [
    "001-mcp-server-index",
    async (_ctx: Context, database: AgentDatabase) => {
        await agentDatabaseRun(
            database,
            sql`CREATE TABLE IF NOT EXISTS mcp_module_index (
                agent_id TEXT NOT NULL,
                name TEXT NOT NULL,
                fingerprint TEXT,
                status TEXT NOT NULL,
                tool_count INTEGER NOT NULL,
                error_message TEXT,
                updated_at BIGINT NOT NULL,
                PRIMARY KEY (agent_id, name)
            )`,
        );
    },
] as const;

export const mcpModuleOptionsSchema = Type.Object(
    {
        maxOutputCharacters: Type.Optional(outputCharactersSchema),
        maxPageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_MCP_PAGE_SIZE })),
    },
    { additionalProperties: false },
);
export type McpModuleOptions = Static<typeof mcpModuleOptionsSchema>;

type McpServerConfig = HappyAgentConfigValues["mcpServers"][string];

interface McpCatalogServer {
    readonly config: McpServerConfig;
    readonly connectionId?: string;
    /** Why this agent may not use the server, in words the model reads. */
    readonly unavailable?: string;
    /**
     * A user-wide stdio server shown to an agent whose folder is still being attached: which
     * machine runs it for that agent is not known yet, so it is reported as connecting.
     */
    readonly awaitingFolder?: true;
    /**
     * For an HTTP server, the catalog a login to it belongs to: `user` for the user-wide catalog
     * on every machine, or the folder catalog's ID, so a folder's login reaches that folder alone.
     */
    readonly loginCatalog?: string;
}

/**
 * What an agent running as its bot's own Linux user is told about a stdio server. Stdio servers
 * are shared by every agent of a folder and run as the workload user, so one such agent using
 * them would be acting as a user its bot was moved away from.
 */
const SEPARATE_USER_STDIO =
    "This bot runs as its own Linux user, and stdio MCP servers run as the installation's workload user, so they are not available to it. HTTP servers still are.";

/**
 * Why a user-wide stdio server is not started on this machine while a runner is the default:
 * nothing runs here then, and every agent gets the server on its own runner instead.
 */
const NO_LOCAL_STDIO =
    "Stdio MCP servers run on the machine of the agent's folder, and this agent has no folder on a machine that can run them.";

interface McpCatalog {
    readonly servers: ReadonlyMap<string, McpCatalogServer>;
}

/** What starting one pooled server takes, kept so a failed server can be started again. */
interface McpConnectionInput {
    readonly config: McpServerConfig;
    readonly name: string;
    readonly runnerId: string | undefined;
    /** The saved login this connection presents, which makes it its catalog's own. */
    readonly login?: McpLoginKey;
}

/**
 * Where one pooled server stands. A connecting server's attempt runs in the background and is
 * adopted only while the entry still holds its token, so a reload, release, or shutdown that got
 * there first wins.
 */
type McpPoolState =
    | {
          readonly kind: "connecting";
          readonly token: object;
          readonly settled: Promise<void>;
      }
    | { readonly kind: "connected"; readonly connection: McpClientConnection }
    | { readonly kind: "failed"; readonly failure: string }
    /**
     * Refused for want of a login. It is never retried in the background: only a reload, a
     * configuration change, or a login checks it again.
     */
    | { readonly kind: "needs_auth"; readonly challenge: McpNeedsAuthError };

/** How a finished attempt left a server. */
type McpAttemptOutcome = Exclude<McpPoolState, { readonly kind: "connecting" }>;

interface McpPooledConnection {
    readonly references: Set<string>;
    readonly input: McpConnectionInput;
    readonly state: McpPoolState;
}

/** A failed server's background retry: how often it has failed again, and the pending attempt. */
interface McpRetry {
    readonly attempts: number;
    readonly timer?: ReturnType<typeof setTimeout>;
}

/**
 * One connection's tools as last listed. Readers on a turn's path take what is here and never
 * wait; a missing or stale listing is refreshed in the background, at most one at a time.
 */
interface McpToolListing {
    /** The reload generation the tools were listed in; an older one is refreshed on next read. */
    generation: number;
    tools?: McpTool[];
    /** Why the last listing failed, while there are no tools to show instead. */
    failure?: string;
    stale: boolean;
    pending?: Promise<void>;
}

/**
 * How a reconcile treats servers that need a login. Only a deliberate reload or configuration
 * change asks them again; attaching a folder or a runner leaves them as they are.
 */
interface McpReconcileOptions {
    readonly recheck: boolean;
}

/** A server attempt a reconcile started, for a deliberate reload to wait on. */
interface McpStartedConnection {
    readonly connectionId: string;
    readonly settled: Promise<void>;
}

/** An agent's folder attachment while it runs in its own lifetime. */
interface McpActivation {
    readonly token: object;
    readonly settled: Promise<void>;
}

/**
 * One shared MCP capability serves every agent and owns the live clients, protocol operations,
 * validation, naming, permission declarations, and model rendering.
 */
export class McpModule implements AgentModule {
    readonly name = "mcp";
    readonly migrations = [mcpMigration, mcpLoginMigration];

    readonly #compute: ComputeModule;
    readonly #config: ConfigModule;
    readonly #runners: RunnersModule;
    readonly #userInput: UserInputModule;
    readonly #maxPageSize: number;
    readonly #maxOutputCharacters: number;
    readonly #reloadLock: AsyncLock = asyncLock({ reentry: "allow" });
    readonly #catalogs = new Map<string, McpCatalog>();
    readonly #pool = new Map<string, McpPooledConnection>();
    /** Each connection's tools, listed once until the server reports a change or a reload. */
    readonly #toolListings = new WeakMap<McpClientConnection, McpToolListing>();
    /** Bumped by every reload, so a server that changed its tools without saying so is listed again. */
    #toolGeneration = 0;
    readonly #retries = new Map<string, McpRetry>();
    /** Folder attachments in progress, one per agent, each in a lifetime of its own. */
    readonly #activations = new Map<string, McpActivation>();
    /** Agents with no working directory, which use only the user-wide catalog on this machine. */
    readonly #folderless = new Set<string>();
    /** Saved logins by key, loaded once from the module's own table. */
    readonly #logins = new Map<string, { readonly key: McpLoginKey; login: McpLogin }>();
    #loginsLoaded: Promise<void> | undefined;
    /** One token presenter per login, so refreshes of one login never overlap. */
    readonly #loginSessions = new Map<string, McpLoginSession>();
    /** Logins waiting on a person, by key, so a second request does not start another. */
    readonly #loginsInProgress = new Set<string>();
    #loginsContext: Context | undefined;
    readonly #agentWorkspaces = new Map<string, string>();
    readonly #workspaceAgents = new Map<string, Set<string>>();
    readonly #archivedWorkspaces = new Set<string>();
    readonly #workspaceFailures = new Map<string, string>();
    readonly #unsubscribeWorkspaceEvents: () => void;
    readonly #unsubscribeRunnerUpdates: () => void;
    /** Runners connected at the last update, so a runner coming back retries its servers once. */
    readonly #connectedRunners = new Set<string>();
    #agents: AgentSystemRef | undefined;
    /** The Linux user each active agent's own work runs as, while some bots have their own. */
    readonly #agentUsers = new Map<string, string>();
    #context: Context | undefined;
    #database: AgentDatabase | undefined;
    #serversContext: Context | undefined;
    #retriesContext: Context | undefined;
    #initialReload: Promise<void> | undefined;
    #closePromise: Promise<void> | undefined;
    #closed = false;

    /**
     * @param runners The owner of the machines folders live on. A stdio server starts on the machine
     * of the folder whose agent uses it: a workspace's own server on that workspace's runner, and
     * a user-wide server once on each runner that has agents, as well as on this machine while
     * work may run here.
     * @param compute The owner of each agent's placement, which says which runner its folder is on.
     */
    constructor(
        config: ConfigModule,
        userInput: UserInputModule,
        workspaces: WorkspacesModule,
        runners: RunnersModule,
        compute: ComputeModule,
        options: McpModuleOptions = {},
    ) {
        if (!Value.Check(mcpModuleOptionsSchema, options)) {
            throw new Error("MCP module options are invalid.");
        }
        this.#compute = compute;
        this.#config = config;
        this.#runners = runners;
        this.#userInput = userInput;
        this.#maxPageSize = options.maxPageSize ?? DEFAULT_PAGE_SIZE;
        this.#maxOutputCharacters = options.maxOutputCharacters ?? DEFAULT_OUTPUT_CHARACTERS;
        this.#unsubscribeWorkspaceEvents = workspaces.onEvent(async (ctx, event) => {
            const workspace = workspaceKey(
                this.#runners,
                event.workspace.runnerId,
                event.workspace.path,
            );
            if (event.type === "workspace_created") {
                await this.#markWorkspaceActive(ctx, workspace);
                return;
            }
            if (
                (event.type === "workspace_updated" && event.change === "begin_archive") ||
                event.type === "workspace_archived"
            ) {
                await this.#releaseWorkspace(ctx, workspace);
            }
        });
        // A runner that goes away takes its servers with it, so they fail at once instead of
        // holding calls until it returns; a server that could not run because its runner was
        // away starts again once the runner is back.
        this.#unsubscribeRunnerUpdates = runners.onUpdated((ctx, snapshot) => {
            const connected = snapshot.runners
                .filter((runner) => runner.status === "connected")
                .map((runner) => runner.id);
            const returned = connected.some((id) => !this.#connectedRunners.has(id));
            this.#connectedRunners.clear();
            for (const id of connected) this.#connectedRunners.add(id);
            this.#failServersOnAbsentRunners();
            if (!returned || this.#closed || this.#initialReload === undefined) return;
            if (![...this.#pool.values()].some((entry) => entry.state.kind === "failed")) return;
            const reloadCtx = detach(ctx).named("mcp-runner-reconnect");
            void this.reload(reloadCtx).catch((error: unknown) => {
                reloadCtx.log.warn(
                    `MCP servers could not start on a runner: ${errorMessage(error)}`,
                );
            });
        });
    }

    readonly #hooks: AgentModuleHooks = {
        /**
         * Keep a durable, bounded server index for prompt projections and restart diagnostics.
         * The live connection catalog remains authoritative; this snapshot is only written
         * through the caller's Agent Storage transaction. Like the tools hook, it never waits for a
         * server: it records what is known now.
         */
        beforeAgentLoop: async (ctx: Context, scope: AgentModuleScope): Promise<void> => {
            this.#attachInBackground(ctx, scope.agent.id);
            const servers = await this.#listAllServers(
                ctx,
                scope.agent.id,
                scope.agent.permissionMode,
            );
            await ctx.inTx(async (txCtx) => {
                await agentDatabaseRun(
                    txCtx.db,
                    sql`DELETE FROM mcp_module_index WHERE agent_id = ${scope.agent.id}`,
                );
                for (const server of servers) {
                    const entry: McpIndexedServer = {
                        agentId: scope.agent.id,
                        ...(server.errorMessage === undefined
                            ? {}
                            : { errorMessage: server.errorMessage }),
                        ...(server.fingerprint === undefined
                            ? {}
                            : { fingerprint: server.fingerprint }),
                        name: server.name,
                        status: server.status,
                        toolCount: server.toolCount,
                        updatedAt: Date.now(),
                    };
                    if (!Value.Check(mcpIndexedServerSchema, entry)) {
                        throw new Error("MCP server index entry is invalid.");
                    }
                    await agentDatabaseRun(
                        txCtx.db,
                        sql`INSERT INTO mcp_module_index
                            (agent_id, name, fingerprint, status, tool_count, error_message, updated_at)
                            VALUES (${entry.agentId}, ${entry.name}, ${entry.fingerprint ?? null},
                                ${entry.status}, ${entry.toolCount}, ${entry.errorMessage ?? null},
                                ${entry.updatedAt})`,
                    );
                }
            });
        },

        /**
         * The dynamic tool list is intentionally rebuilt from the current connected catalog, so
         * an online reload reaches the next provider request without restarting the daemon.
         *
         * Nothing here waits for a server. The tools are whatever is connected and listed right
         * now; a folder still attaching, a server still starting, or a listing not yet back is
         * started in the background, and its tools reach a later request.
         */
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            const agentId = assertAgentId(scope.agent.id);
            this.#attachInBackground(ctx, agentId);
            const servers = await this.#listAllServers(ctx, agentId, scope.agent.permissionMode);
            const connected = servers.filter((server) => server.status === "connected");
            const loadedTools: AnyAgentTool[] = [];
            for (const server of connected) {
                const tools = this.#listedTools(agentId, server.name);
                if (loadedTools.length + tools.length > MAX_MCP_TOTAL_TOOLS) {
                    throw new Error("MCP tool catalog exceeded its bound.");
                }
                for (const tool of tools) {
                    // A server outside this repo may describe its tool with any JSON Schema, but every
                    // provider requires an object at the root and refuses the whole request otherwise.
                    // Dropping the one tool keeps a single odd server from breaking every turn.
                    if (!isObjectRootedSchema(tool.inputSchema)) {
                        ctx.log.warn(
                            `The ${tool.name} tool from ${server.name} is unavailable: its input schema is not an object at the top level.`,
                        );
                        continue;
                    }
                    try {
                        loadedTools.push(createMcpTool(this, agentId, server.name, tool));
                    } catch (error) {
                        ctx.log.warn(
                            `The ${tool.name} tool from ${server.name} is unavailable: ${errorMessage(error)}`,
                        );
                    }
                }
            }
            const merged = mergeMcpTools([], { servers: connected, tools: loadedTools });
            const quarantined = merged.servers.filter((server) => server.status === "failed");
            const protocolTools = merged.servers.every((server) => server.status !== "connected")
                ? []
                : createMcpProtocolTools(
                      this,
                      agentId,
                      merged.servers
                          .filter((server) => server.status === "connected")
                          .map((server) => ({ name: server.name })),
                  );
            return [
                listMcpServersTool(this, agentId, scope.agent.permissionMode, quarantined),
                ...createMcpConfigurationTools(this, agentId),
                startMcpAuthTool(this, agentId),
                ...merged.tools,
                ...protocolTools,
            ];
        },
        // Creation and restoration only start attaching the agent's folder. Restoration runs while
        // the daemon starts, and a folder's servers may take as long as their startup timeouts.
        agentCreated: (
            ctx: Context,
            scope: AgentModuleSystemScope,
            agent: AgentModuleAgentLifecycle,
        ): void => {
            this.#rememberContext(ctx);
            this.#logActivationFailure(ctx, agent.id, this.#activate(scope.agents, agent.id));
        },
        agentRestored: (
            ctx: Context,
            scope: AgentModuleSystemScope,
            agent: AgentModuleAgentLifecycle,
        ): void => {
            this.#rememberContext(ctx);
            this.#logActivationFailure(ctx, agent.id, this.#activate(scope.agents, agent.id));
        },
        agentArchived: async (
            ctx: Context,
            _scope: AgentModuleSystemScope,
            agent: AgentModuleAgentLifecycle,
        ): Promise<void> => {
            await this.#releaseAgent(ctx, agent.id);
        },
    };

    readonly beforeStart = (ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        this.#context ??= ctx;
        this.#database ??= agentDatabase(ctx);
        this.#initialReload ??= this.reload(ctx).catch((error: unknown) => {
            ctx.log.warn(`Initial MCP discovery failed: ${errorMessage(error)}`);
        });
        return this.#hooks;
    };

    /** Reconcile the global mcp.toml without restarting unchanged shared connections. */
    async reload(ctx: Context): Promise<void> {
        this.#rememberContext(ctx);
        this.#assertOpen();
        const started = await this.#reloadLock.runInLock(ctx, async () => {
            this.#assertOpen();
            const servers = await this.#config.readMcpServers();
            const globalNames = new Set(Object.keys(servers));
            const workspaceServers = await Promise.all(
                [...this.#workspaceAgents.keys()].map(async (workspace) => {
                    try {
                        const workspaceCatalogServers = withoutServerNames(
                            await this.#readWorkspaceServers(workspace),
                            globalNames,
                        );
                        this.#workspaceFailures.delete(workspace);
                        return { workspace, servers: workspaceCatalogServers };
                    } catch (error) {
                        this.#recordWorkspaceFailure(ctx, workspace, error);
                        const current = this.#catalogs.get(workspaceCatalog(workspace));
                        return current === undefined
                            ? undefined
                            : {
                                  workspace,
                                  servers: withoutServerNames(
                                      catalogServerConfigs(current),
                                      globalNames,
                                  ),
                              };
                    }
                }),
            );
            // A server that changes its tools without saying so shows them after a reload.
            this.#toolGeneration += 1;
            return await this.#reconcileCatalogs(
                ctx,
                new Map([
                    [GLOBAL_CATALOG, servers],
                    ...[...this.#activeRunners()].map(
                        (runnerId) => [runnerGlobalCatalog(runnerId), servers] as const,
                    ),
                    ...workspaceServers.flatMap((entry) =>
                        entry === undefined
                            ? []
                            : [[workspaceCatalog(entry.workspace), entry.servers] as const],
                    ),
                ]),
                { recheck: true },
            );
        });
        await this.#settled(started);
    }

    /** Reconcile only the workspace catalog used by the calling agent. */
    async reloadWorkspace(ctx: Context, agentId: string): Promise<void> {
        this.#rememberContext(ctx);
        this.#assertOpen();
        assertAgentId(agentId);
        await this.#ensureAgentWorkspace(agentId);
        const started = await this.#reloadLock.runInLock(ctx, async () => {
            this.#assertOpen();
            this.#toolGeneration += 1;
            return await this.#reconcileWorkspace(ctx, this.#attachedWorkspace(agentId), {
                recheck: true,
            });
        });
        await this.#settled(started);
    }

    async configureServer(
        ctx: Context,
        name: string,
        server: HappyAgentConfigValues["mcpServers"][string] | undefined,
    ): Promise<void> {
        this.#assertOpen();
        await this.#config.updateMcpServer(ctx, name, server);
        await this.reload(ctx);
    }

    /**
     * Add, replace, or remove one server in the `mcp.toml` of the calling agent's folder, which
     * every agent in that folder shares, then reconcile only that folder's catalog.
     */
    async configureWorkspaceServer(
        ctx: Context,
        agentId: string,
        name: string,
        server: HappyAgentConfigValues["mcpServers"][string] | undefined,
    ): Promise<void> {
        this.#rememberContext(ctx);
        this.#assertOpen();
        assertAgentId(agentId);
        await this.#ensureAgentWorkspace(agentId);
        const started = await this.#reloadLock.runInLock(ctx, async () => {
            this.#assertOpen();
            const workspace = this.#attachedWorkspace(agentId);
            if (server !== undefined && this.#catalogs.get(GLOBAL_CATALOG)?.servers.has(name)) {
                throw new Error(
                    `The user-wide MCP catalog already has a server named "${name}", and it takes precedence over this folder's. Choose another name, or change the user-wide server instead.`,
                );
            }
            const { path, runnerId } = parseWorkspaceKey(workspace);
            await this.#config.updateWorkspaceMcpServer(
                ctx,
                path,
                name,
                server,
                await this.#workspaceMachine(runnerId),
            );
            return await this.#reconcileWorkspace(ctx, workspace, { recheck: true });
        });
        await this.#settled(started);
    }

    /** Where configuration actually reads and writes the shared user catalog. */
    userMcpConfigLocation(): string {
        return this.#config.userMcpConfigLocation();
    }

    /**
     * Where the calling agent's folder catalog lives, in words an approval can show, or undefined
     * while the agent is not attached to a folder.
     */
    workspaceMcpConfigLocation(agentId: string): string | undefined {
        const workspace = this.#agentWorkspaces.get(agentId);
        if (workspace === undefined) return undefined;
        const { path, runnerId } = parseWorkspaceKey(workspace);
        const file = this.#config.workspaceMcpConfigPath(path);
        return runnerId === undefined
            ? file
            : `${file} on the runner ${this.#runners.displayName(runnerId)}`;
    }

    /**
     * Log in to one HTTP server in the calling agent's catalog, for everyone using that catalog:
     * the user-wide catalog, or the agent's folder. The person gets the sign-in link in a question
     * only they can answer, and finishes by pasting back the address their browser landed on, or
     * by landing on it in a browser on this machine. The result says how it went and never carries
     * a token, a code, or anything the authorization server said.
     */
    async startAuth(ctx: Context, agentId: string, name: string): Promise<McpAuthResult> {
        this.#rememberContext(ctx);
        this.#assertOpen();
        assertAgentId(agentId);
        await this.#ensureAgentWorkspace(agentId);
        const result = (status: McpAuthResult["status"], message: string): McpAuthResult => ({
            server: name,
            status,
            message: message.slice(0, MAX_MCP_ERROR_MESSAGE_LENGTH),
        });
        const server = this.#effectiveServers(agentId).get(name);
        if (server === undefined) {
            return result("failed", `No MCP server named "${name}" is configured for this agent.`);
        }
        const { config } = server;
        if (config.transport === "stdio") return result("not_needed", stdioLoginMessage(name));
        if (config.enabled === false) {
            return result("not_needed", `MCP server "${name}" is disabled in its mcp.toml.`);
        }
        if (hasConfiguredAuthorization(config)) {
            return result(
                "not_needed",
                `MCP server "${name}" signs in with the credential configured for it in mcp.toml, so Happy does not log in to it. If that credential is refused, it has to be changed there.`,
            );
        }
        if (server.unavailable !== undefined) return result("failed", server.unavailable);
        const loginCatalog = server.loginCatalog;
        const pooled =
            server.connectionId === undefined ? undefined : this.#pool.get(server.connectionId);
        if (loginCatalog === undefined)
            return result("failed", `MCP server "${name}" is not ready.`);
        if (pooled?.state.kind === "connected") {
            return result(
                "not_needed",
                `MCP server "${name}" is connected and is not asking for a login.`,
            );
        }
        const key: McpLoginKey = { catalog: loginCatalog, name, url: config.url };
        const keyId = mcpLoginKeyId(key);
        if (this.#loginsInProgress.has(keyId)) {
            return result(
                "failed",
                `A sign-in to "${name}" is already waiting for the person. They can finish or dismiss that one first.`,
            );
        }
        this.#loginsInProgress.add(keyId);
        try {
            const challenge =
                pooled?.state.kind === "needs_auth" ? pooled.state.challenge : undefined;
            const state = randomBytes(32).toString("base64url");
            const callback = await McpLoginCallback.open(state);
            try {
                const pending = await beginMcpLogin({
                    serverUrl: new URL(config.url),
                    redirectUri: callback.redirectUri,
                    state,
                    scope: config.oauthScopes?.join(" ") ?? challenge?.scope,
                    resourceMetadataUrl: challenge?.resourceMetadataUrl,
                    configuredClient: configuredLoginClient(config),
                });
                const pasted = await this.#askToSignIn(
                    ctx,
                    agentId,
                    name,
                    pending.authorizationUrl,
                    callback,
                    loginCatalog,
                );
                if (pasted === undefined) {
                    return result(
                        "cancelled",
                        `The sign-in to "${name}" was not finished: the person dismissed it, was away, or the turn stopped. Nothing was saved.`,
                    );
                }
                const login = await pending.complete(pasted);
                await writeMcpLogin(ctx, key, login);
                const saved = this.#logins.get(keyId);
                if (saved === undefined) this.#logins.set(keyId, { key, login });
                else saved.login = login;
            } finally {
                callback.close();
            }
        } catch (error) {
            if (error instanceof McpLoginError) {
                return result("failed", `The login to "${name}" did not work: ${error.message}`);
            }
            ctx.log.warn(`The MCP login to ${name} failed: ${errorMessage(error)}`);
            return result("failed", `The login to "${name}" did not work.`);
        } finally {
            this.#loginsInProgress.delete(keyId);
        }

        await this.#reconnectLoginCatalog(ctx, loginCatalog);
        const after = this.#effectiveServers(agentId).get(name);
        const summary = after === undefined ? undefined : this.#serverSummary(name, after);
        if (summary?.status === "connected") {
            return result(
                "logged_in",
                `Logged in to "${name}". Its tools reach the next request, and the login is shared by ${loginAudience(loginCatalog)}.`,
            );
        }
        return result(
            "saved",
            `The login to "${name}" was saved for ${loginAudience(loginCatalog)}, but the server is ${summary?.status ?? "not connected"}${summary?.errorMessage === undefined ? "." : `: ${summary.errorMessage}`}`,
        );
    }

    /** What an approval of a login says it does, naming the server, its host, and who shares it. */
    describeAuthAction(agentId: string, name: string): string {
        const server = this.#effectiveServers(agentId).get(name);
        if (server?.config.transport !== "http" || server.loginCatalog === undefined) {
            return `explaining how to log in to MCP server “${name}”`;
        }
        return `logging in to MCP server “${name}” at ${new URL(server.config.url).origin} through the authorization server it names; the person signs in in their own browser, and the saved login is used for ${loginAudience(server.loginCatalog)}`;
    }

    /**
     * Ask the person to sign in, and return the address their browser landed on, or undefined
     * when they dismissed the question, were away, or the turn stopped. Only the person can answer
     * it: no agent tool answers a question.
     */
    async #askToSignIn(
        ctx: Context,
        agentId: string,
        name: string,
        link: URL,
        callback: McpLoginCallback,
        loginCatalog: string,
    ): Promise<string | undefined> {
        const title = humanizeMcpName(name);
        const pending = await this.#userInput.askForPermission(
            ctx,
            agentId,
            {
                context: [
                    `**${title}** is an MCP server that needs you to sign in. The sign-in page is on **${link.host}**.`,
                    "",
                    `1. Open this link and sign in: ${link.href}`,
                    `2. Your browser then opens an address that starts with \`${callback.redirectUri}\`. That page may not load, which is expected.`,
                    "3. Copy the whole address from the browser's address bar and paste it here.",
                    "",
                    `The login is saved for ${loginAudience(loginCatalog)}. If you did not ask to log in, dismiss this.`,
                ].join("\n"),
                questions: [
                    {
                        id: "address",
                        header: "Sign-in address",
                        question: `After signing in to ${title}, paste the full address your browser opened.`,
                    },
                ],
            },
            {
                source: "mcp_elicitation",
                server: name,
                serverTitle: boundServerTitle(title),
            },
        );
        const withdraw = (reason: string): void => {
            this.#userInput
                .cancel(ctx, agentId, { requestId: pending.id, reason })
                .catch((error: unknown) => {
                    ctx.log.warn(
                        `Could not withdraw the sign-in question for ${name}: ${errorMessage(error)}`,
                    );
                });
        };
        const stopped = (): void => withdraw("The sign-in was stopped.");
        ctx.lifetime?.addEventListener("abort", stopped, { once: true });
        if (ctx.lifetime?.aborted === true) stopped();
        try {
            return await Promise.race([
                callback.received.then((address) => {
                    withdraw("Signed in from a browser on this machine.");
                    return address;
                }),
                this.#userInput
                    .wait(ctx, agentId, pending.id)
                    .then((settled) =>
                        settled.status === "answered"
                            ? userInputAnswerStrings(settled.answers?.address).join(" ") ||
                              undefined
                            : undefined,
                    ),
            ]);
        } finally {
            ctx.lifetime?.removeEventListener("abort", stopped);
        }
    }

    /** Reconcile every catalog a login belongs to, checking its servers again, and wait for them. */
    async #reconnectLoginCatalog(ctx: Context, loginCatalog: string): Promise<void> {
        const started = await this.#reloadLock.runInLock(ctx, async () => {
            this.#assertOpen();
            const catalogs = new Map(
                [...this.#catalogs.entries()]
                    .filter(([catalogId]) => loginCatalogOf(catalogId) === loginCatalog)
                    .map(([catalogId, catalog]) => [catalogId, catalogServerConfigs(catalog)]),
            );
            return await this.#reconcileCatalogs(ctx, catalogs, { recheck: true });
        });
        await this.#settled(started);
    }

    /** Read the saved logins once, before the first catalog with an HTTP server is reconciled. */
    async #loadLogins(): Promise<void> {
        // A module started without storage has no saved logins to read.
        if (this.#database === undefined) return;
        this.#loginsLoaded ??= (async () => {
            for (const [id, entry] of await readMcpLogins(this.#loginsLifetime())) {
                if (!this.#logins.has(id)) this.#logins.set(id, { ...entry });
            }
        })().catch((error: unknown) => {
            this.#loginsLoaded = undefined;
            this.#loginsLifetime().log.warn(
                `Saved MCP logins could not be read: ${errorMessage(error)}`,
            );
        });
        await this.#loginsLoaded;
    }

    /** The one token presenter of a login, shared by every connection that uses it. */
    #loginSession(
        key: McpLoginKey,
        config: Extract<McpServerConfig, { transport: "http" }>,
    ): McpLoginSession {
        const id = mcpLoginKeyId(key);
        let session = this.#loginSessions.get(id);
        if (session !== undefined) return session;
        session = new McpLoginSession({
            serverUrl: new URL(config.url),
            read: () => this.#logins.get(id)?.login,
            // The new login is used at once; saving it is for the next daemon, so a failure to
            // save is logged rather than failing the request that refreshed it.
            save: async (login) => {
                const saved = this.#logins.get(id);
                if (saved === undefined) this.#logins.set(id, { key, login });
                else saved.login = login;
                await writeMcpLogin(this.#loginsLifetime(), key, login).catch((error: unknown) => {
                    this.#loginsLifetime().log.warn(
                        `The refreshed MCP login for ${key.name} could not be saved: ${errorMessage(error)}`,
                    );
                });
            },
            client: (login) =>
                login.client.kind === "registered"
                    ? {
                          client_id: login.client.clientId,
                          ...(login.client.clientSecret === undefined
                              ? {}
                              : { client_secret: login.client.clientSecret }),
                      }
                    : configuredLoginClientOrUndefined(config),
        });
        this.#loginSessions.set(id, session);
        return session;
    }

    /**
     * The lifetime saved logins are read and refreshed logins written in. Detaching drops the
     * database, so the one the daemon started with is handed back deliberately.
     */
    #loginsLifetime(): Context {
        const root = this.#context;
        if (root === undefined) throw new Error("The MCP module has not started.");
        if (this.#loginsContext === undefined) {
            const lifetime = detach(root).named("mcp-logins");
            this.#loginsContext =
                this.#database === undefined
                    ? lifetime
                    : withAgentDatabase(lifetime, this.#database);
        }
        return this.#loginsContext;
    }

    async close(): Promise<void> {
        if (this.#closePromise !== undefined) return await this.#closePromise;
        this.#closed = true;
        this.#unsubscribeWorkspaceEvents();
        this.#unsubscribeRunnerUpdates();
        this.#scheduleRetries();
        const close = async (): Promise<void> => {
            const connections = [...this.#pool.values()].flatMap((entry) =>
                entry.state.kind === "connected" ? [entry.state.connection] : [],
            );
            this.#pool.clear();
            this.#catalogs.clear();
            this.#activations.clear();
            this.#agentWorkspaces.clear();
            this.#workspaceAgents.clear();
            this.#archivedWorkspaces.clear();
            this.#workspaceFailures.clear();
            await Promise.allSettled(connections.map(async (entry) => await entry.close()));
        };
        this.#closePromise =
            this.#context === undefined
                ? close()
                : this.#reloadLock.runInLock(this.#context, async () => await close());
        await this.#closePromise;
    }

    async listServerPage(
        _ctx: Context,
        agentId: string,
        query: McpServerPageQuery = {},
        _permissionMode: McpPermissionMode = "auto",
    ): Promise<McpServerPage> {
        assertAgentId(agentId);
        if (!Value.Check(mcpServerPageQuerySchema, query)) {
            throw new Error("MCP server page query is invalid.");
        }
        const normalized = {
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            limit: Math.min(
                query.limit ?? this.#maxPageSize,
                this.#maxPageSize,
                this.#maximumVisibleRows(24),
            ),
        };
        // A server still starting, or whose tools are still being listed, is reported as
        // connecting rather than waited for.
        const all = [...this.#effectiveServers(agentId).entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, server]) => this.#serverSummary(name, server));
        const raw = pageFrom(all, normalized.cursor, normalized.limit, "servers");
        assertServerPage(raw);
        if (raw.servers.length > normalized.limit) {
            throw new Error("MCP server page returned more servers than requested.");
        }
        assertUnique(
            raw.servers.map((server) => server.name),
            "server",
        );
        assertCursorProgress(query.cursor, raw.nextCursor, raw.servers.length);
        return structuredClone(raw);
    }

    async listServers(
        ctx: Context,
        agentId: string,
        query: McpServerPageQuery = {},
        permissionMode: McpPermissionMode = "auto",
    ): Promise<readonly McpServerSummary[]> {
        return (await this.listServerPage(ctx, agentId, query, permissionMode)).servers;
    }

    async listToolPage(
        ctx: Context,
        agentId: string,
        query: McpToolPageQuery,
    ): Promise<McpToolPage> {
        assertAgentId(agentId);
        if (!Value.Check(mcpToolPageQuerySchema, query)) {
            throw new Error("MCP tool page query is invalid.");
        }
        const normalized = {
            server: query.server,
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            limit: Math.min(
                query.limit ?? this.#maxPageSize,
                this.#maxPageSize,
                this.#maximumVisibleRows(1),
            ),
        };
        const raw = pageFrom(
            await this.#allTools(ctx, this.#connection(agentId, normalized.server)),
            normalized.cursor,
            normalized.limit,
            "tools",
        );
        assertToolPage(raw);
        if (raw.tools.length > normalized.limit) {
            throw new Error("MCP server page returned more tools than requested.");
        }
        assertUnique(
            raw.tools.map((tool) => tool.name),
            "tool",
        );
        assertCursorProgress(query.cursor, raw.nextCursor, raw.tools.length);
        return structuredClone(raw);
    }

    async listTools(
        ctx: Context,
        agentId: string,
        server: string,
        cursor?: string,
    ): Promise<readonly McpTool[]>;
    async listTools(ctx: Context, agentId: string, query: McpToolPageQuery): Promise<McpToolPage>;
    async listTools(
        ctx: Context,
        agentId: string,
        serverOrQuery: string | McpToolPageQuery,
        cursor?: string,
    ): Promise<readonly McpTool[] | McpToolPage> {
        const query: McpToolPageQuery =
            typeof serverOrQuery === "string"
                ? { server: serverOrQuery, ...(cursor === undefined ? {} : { cursor }) }
                : serverOrQuery;
        const page = await this.listToolPage(ctx, agentId, query);
        return typeof serverOrQuery === "string" ? page.tools : page;
    }

    async listResourcePage(
        ctx: Context,
        agentId: string,
        query: McpResourcePageQuery,
    ): Promise<McpResourcePage> {
        assertAgentId(agentId);
        if (!Value.Check(mcpResourcePageQuerySchema, query)) {
            throw new Error("MCP resource page query is invalid.");
        }
        const normalized = {
            server: query.server,
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            limit: Math.min(
                query.limit ?? this.#maxPageSize,
                this.#maxPageSize,
                this.#maximumVisibleRows(1),
            ),
        };
        const raw = pageFrom(
            await this.#allResources(ctx, this.#connection(agentId, normalized.server)),
            normalized.cursor,
            normalized.limit,
            "resources",
        );
        assertResourcePage(raw);
        if (raw.resources.length > normalized.limit) {
            throw new Error("MCP server page returned more resources than requested.");
        }
        assertUnique(
            raw.resources.map((resource) => resource.uri),
            "resource",
        );
        assertCursorProgress(query.cursor, raw.nextCursor, raw.resources.length);
        return structuredClone(raw);
    }

    async listResources(
        ctx: Context,
        agentId: string,
        server: string,
        cursor?: string,
    ): Promise<readonly McpResourcePage["resources"][number][]>;
    async listResources(
        ctx: Context,
        agentId: string,
        query: McpResourcePageQuery,
    ): Promise<McpResourcePage>;
    async listResources(
        ctx: Context,
        agentId: string,
        serverOrQuery: string | McpResourcePageQuery,
        cursor?: string,
    ): Promise<readonly McpResourcePage["resources"][number][] | McpResourcePage> {
        const query: McpResourcePageQuery =
            typeof serverOrQuery === "string"
                ? { server: serverOrQuery, ...(cursor === undefined ? {} : { cursor }) }
                : serverOrQuery;
        const page = await this.listResourcePage(ctx, agentId, query);
        return typeof serverOrQuery === "string" ? page.resources : page;
    }

    async listResourceTemplatePage(
        ctx: Context,
        agentId: string,
        query: McpResourcePageQuery,
    ): Promise<McpResourceTemplatePage> {
        assertAgentId(agentId);
        if (!Value.Check(mcpResourcePageQuerySchema, query)) {
            throw new Error("MCP resource-template page query is invalid.");
        }
        const normalized = {
            server: query.server,
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            limit: Math.min(
                query.limit ?? this.#maxPageSize,
                this.#maxPageSize,
                this.#maximumVisibleRows(1),
            ),
        };
        const raw = pageFrom(
            await this.#allResourceTemplates(ctx, this.#connection(agentId, normalized.server)),
            normalized.cursor,
            normalized.limit,
            "resourceTemplates",
        );
        assertResourceTemplatePage(raw);
        if (raw.resourceTemplates.length > normalized.limit) {
            throw new Error("MCP server page returned more resource templates than requested.");
        }
        assertUnique(
            raw.resourceTemplates.map((template) => template.uriTemplate),
            "resource template",
        );
        assertCursorProgress(query.cursor, raw.nextCursor, raw.resourceTemplates.length);
        return structuredClone(raw);
    }

    async listPromptPage(
        ctx: Context,
        agentId: string,
        query: McpPromptPageQuery,
    ): Promise<McpPromptPage> {
        assertAgentId(agentId);
        if (!Value.Check(mcpPromptPageQuerySchema, query)) {
            throw new Error("MCP prompt page query is invalid.");
        }
        const normalized = {
            server: query.server,
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            limit: Math.min(
                query.limit ?? this.#maxPageSize,
                this.#maxPageSize,
                this.#maximumVisibleRows(1),
            ),
        };
        const raw = pageFrom(
            await this.#allPrompts(ctx, this.#connection(agentId, normalized.server)),
            normalized.cursor,
            normalized.limit,
            "prompts",
        );
        assertPromptPage(raw);
        if (raw.prompts.length > normalized.limit) {
            throw new Error("MCP server page returned more prompts than requested.");
        }
        assertUnique(
            raw.prompts.map((prompt) => prompt.name),
            "prompt",
        );
        assertCursorProgress(query.cursor, raw.nextCursor, raw.prompts.length);
        return structuredClone(raw);
    }

    async callTool(
        ctx: Context,
        agentId: string,
        inputOrServer: McpCallToolInput | string,
        name?: string,
        toolArguments?: Record<string, unknown>,
    ): Promise<McpToolResult> {
        assertAgentId(agentId);
        const input: McpCallToolInput =
            typeof inputOrServer === "string"
                ? {
                      server: inputOrServer,
                      name: name ?? "",
                      ...(toolArguments === undefined ? {} : { arguments: toolArguments }),
                  }
                : inputOrServer;
        if (!Value.Check(mcpCallToolInputSchema, input)) {
            throw new Error("MCP tool call input is invalid.");
        }
        const policy = await this.#toolPolicy(ctx, agentId, input.server);
        if (policy !== undefined && !isMcpToolAllowed(policy, input.name)) {
            throw new Error(`The MCP tool "${input.name}" is disabled by the server policy.`);
        }
        const raw = await this.#connection(agentId, input.server).callTool(
            ctx,
            input,
            async (request, signal) =>
                await handleMcpElicitation(
                    input.server,
                    request,
                    this.#mcpUserInputService(ctx, agentId, input.server, signal),
                ),
        );
        if (!Value.Check(mcpToolResultSchema, raw)) {
            throw new Error("MCP server returned an invalid tool result.");
        }
        return structuredClone(raw);
    }

    async readResource(
        ctx: Context,
        agentId: string,
        inputOrServer: McpReadResourceInput | string,
        uri?: string,
    ): Promise<McpReadResourceResult> {
        assertAgentId(agentId);
        const input: McpReadResourceInput =
            typeof inputOrServer === "string"
                ? { server: inputOrServer, uri: uri ?? "" }
                : inputOrServer;
        if (!Value.Check(mcpReadResourceInputSchema, input)) {
            throw new Error("MCP resource read input is invalid.");
        }
        const connection = this.#connection(agentId, input.server);
        const raw = await connection.client.readResource(
            { uri: input.uri },
            this.#requestOptions(ctx, connection.config.toolTimeoutMs),
        );
        if (!Value.Check(mcpReadResourceResultSchema, raw)) {
            throw new Error("MCP server returned an invalid resource result.");
        }
        for (const content of raw.contents) {
            if (isRecord(content) && typeof content.uri === "string" && content.uri !== input.uri) {
                throw new Error("MCP resource result belongs to a different URI.");
            }
        }
        return structuredClone(raw);
    }

    async getPrompt(
        ctx: Context,
        agentId: string,
        input: McpGetPromptInput,
    ): Promise<McpGetPromptResult> {
        assertAgentId(agentId);
        if (!Value.Check(mcpGetPromptInputSchema, input)) {
            throw new Error("MCP prompt input is invalid.");
        }
        const connection = this.#connection(agentId, input.server);
        const raw = await connection.client.getPrompt(
            {
                name: input.name,
                ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
            },
            this.#requestOptions(ctx, connection.config.toolTimeoutMs),
        );
        if (!Value.Check(mcpGetPromptResultSchema, raw)) {
            throw new Error("MCP server returned an invalid prompt result.");
        }
        return structuredClone(raw);
    }

    formatServerPageForModel(page: McpServerPage): string {
        if (!Value.Check(mcpServerPageSchema, page)) {
            throw new Error("Cannot format an invalid MCP server page.");
        }
        const identities = page.servers.map(
            (server) => `${server.name}\t${server.status}\t${String(server.toolCount)} tools`,
        );
        const suffixes = page.servers.map((server) =>
            server.errorMessage === undefined ? undefined : ` — ${server.errorMessage}`,
        );
        return formatIdentityRows(
            identities,
            suffixes,
            page.nextCursor,
            this.#maxOutputCharacters,
            "No MCP servers.",
        );
    }

    formatToolPageForModel(page: McpToolPage): string {
        if (!Value.Check(mcpToolPageSchema, page)) {
            throw new Error("Cannot format an invalid MCP tool page.");
        }
        return formatIdentityRows(
            page.tools.map((tool) => tool.name),
            page.tools.map((tool) =>
                tool.description === undefined ? undefined : ` — ${tool.description}`,
            ),
            page.nextCursor,
            this.#maxOutputCharacters,
            "No MCP tools.",
        );
    }

    formatResourcePageForModel(page: McpResourcePage): string {
        if (!Value.Check(mcpResourcePageSchema, page)) {
            throw new Error("Cannot format an invalid MCP resource page.");
        }
        return formatIdentityRows(
            page.resources.map((resource) => resource.uri),
            page.resources.map((resource) =>
                resource.name === resource.uri ? undefined : ` — ${resource.name}`,
            ),
            page.nextCursor,
            this.#maxOutputCharacters,
            "No MCP resources.",
        );
    }

    formatResourceTemplatePageForModel(page: McpResourceTemplatePage): string {
        if (!Value.Check(mcpResourceTemplatePageSchema, page)) {
            throw new Error("Cannot format an invalid MCP resource-template page.");
        }
        return formatIdentityRows(
            page.resourceTemplates.map((template) => template.uriTemplate),
            page.resourceTemplates.map((template) =>
                template.name === template.uriTemplate ? undefined : ` — ${template.name}`,
            ),
            page.nextCursor,
            this.#maxOutputCharacters,
            "No MCP resource templates.",
        );
    }

    formatPromptPageForModel(page: McpPromptPage): string {
        if (!Value.Check(mcpPromptPageSchema, page)) {
            throw new Error("Cannot format an invalid MCP prompt page.");
        }
        return formatIdentityRows(
            page.prompts.map((prompt) => prompt.name),
            page.prompts.map((prompt) =>
                prompt.description === undefined ? undefined : ` — ${prompt.description}`,
            ),
            page.nextCursor,
            this.#maxOutputCharacters,
            "No MCP prompts.",
        );
    }

    formatToolResultForModel(
        result: McpToolResult,
    ): readonly ReturnType<typeof mcpResultToContentBlocks>[number][] {
        if (!Value.Check(mcpToolResultSchema, result)) {
            throw new Error("Cannot format an invalid MCP tool result.");
        }
        return mcpResultToContentBlocks(result);
    }

    /** One server as an agent sees it right now, without waiting on the server. */
    #serverSummary(name: string, server: McpCatalogServer): McpServerSummary {
        const { config } = server;
        if (config.enabled === false) {
            return { name, status: "disabled", toolCount: 0 };
        }
        if (server.unavailable !== undefined) {
            return { name, status: "failed", toolCount: 0, errorMessage: server.unavailable };
        }
        if (server.awaitingFolder === true) {
            return { name, status: "connecting", toolCount: 0 };
        }
        const pooled =
            server.connectionId === undefined ? undefined : this.#pool.get(server.connectionId);
        const state = pooled?.state;
        if (state === undefined) {
            return { name, status: "failed", toolCount: 0, errorMessage: "Connection failed." };
        }
        if (state.kind === "connecting") return { name, status: "connecting", toolCount: 0 };
        if (state.kind === "failed") {
            return { name, status: "failed", toolCount: 0, errorMessage: state.failure };
        }
        if (state.kind === "needs_auth") {
            return {
                name,
                status: "needs_auth",
                toolCount: 0,
                errorMessage: needsAuthMessage(name, state.challenge),
            };
        }
        const listing = this.#toolListing(state.connection);
        if (listing.tools === undefined) {
            return listing.failure === undefined
                ? { name, status: "connecting", toolCount: 0 }
                : { name, status: "failed", toolCount: 0, errorMessage: listing.failure };
        }
        const capabilities = state.connection.client.getServerCapabilities();
        return {
            name,
            status: "connected",
            toolCount: listing.tools.length,
            ...(config.enabledTools === undefined
                ? {}
                : { enabledTools: [...config.enabledTools] }),
            ...(config.disabledTools === undefined
                ? {}
                : { disabledTools: [...config.disabledTools] }),
            ...(capabilities?.prompts === undefined ? {} : { promptSupport: true }),
            ...(capabilities?.resources === undefined ? {} : { resourceSupport: true }),
        };
    }

    /** The tools a connected server listed last, or none while they are still being listed. */
    #listedTools(agentId: string, server: string): readonly McpTool[] {
        const pooled = this.#pool.get(
            this.#effectiveServers(agentId).get(server)?.connectionId ?? "",
        );
        if (pooled?.state.kind !== "connected") return [];
        const tools = this.#toolListing(pooled.state.connection).tools ?? [];
        assertUnique(
            tools.map((tool) => tool.name),
            "tool",
        );
        return tools;
    }

    async #listAllServers(
        ctx: Context,
        agentId: string,
        permissionMode: McpPermissionMode,
    ): Promise<readonly McpServerSummary[]> {
        const servers: McpServerSummary[] = [];
        let cursor: string | undefined;
        for (let pageCount = 0; pageCount < MAX_MCP_PAGE_SIZE; pageCount += 1) {
            const page = await this.listServerPage(
                ctx,
                agentId,
                {
                    ...(cursor === undefined ? {} : { cursor }),
                    limit: this.#maxPageSize,
                },
                permissionMode,
            );
            servers.push(...page.servers);
            if (page.nextCursor === undefined) {
                assertUnique(
                    servers.map((server) => server.name),
                    "server",
                );
                return servers;
            }
            cursor = page.nextCursor;
        }
        throw new Error("MCP server pagination exceeded its bound.");
    }

    #maximumVisibleRows(rowOverhead: number): number {
        const continuationBudget = "More results at cursor ".length + MAX_MCP_CURSOR_LENGTH + 1;
        const rowBudget = 128 + rowOverhead + 1;
        const available = this.#maxOutputCharacters - continuationBudget;
        return Math.max(1, Math.min(MAX_MCP_PAGE_SIZE, Math.floor((available + 1) / rowBudget)));
    }

    async #toolPolicy(
        ctx: Context,
        agentId: string,
        serverName: string,
    ): Promise<McpToolPolicy | undefined> {
        const server = (await this.#listAllServers(ctx, agentId, "auto")).find(
            (candidate) => candidate.name === serverName,
        );
        const policy =
            server === undefined
                ? undefined
                : {
                      ...(server.disabledTools === undefined
                          ? {}
                          : { disabledTools: [...server.disabledTools] }),
                      ...(server.enabledTools === undefined
                          ? {}
                          : { enabledTools: [...server.enabledTools] }),
                  };
        if (policy !== undefined && !Value.Check(mcpToolPolicySchema, policy)) {
            throw new Error("MCP server summary contained an invalid tool policy.");
        }
        return policy === undefined ? undefined : structuredClone(policy);
    }

    #connection(agentId: string, name: string): McpClientConnection {
        const server = this.#effectiveServers(agentId).get(name);
        if (server?.unavailable !== undefined) throw new Error(server.unavailable);
        if (server?.awaitingFolder === true) {
            throw new Error(`MCP server "${name}" is still connecting.`);
        }
        const pooled =
            server?.connectionId === undefined ? undefined : this.#pool.get(server.connectionId);
        const state = pooled?.state;
        if (state?.kind === "connected") return state.connection;
        if (state?.kind === "connecting") {
            throw new Error(`MCP server "${name}" is still connecting.`);
        }
        if (state?.kind === "needs_auth") throw new Error(needsAuthMessage(name, state.challenge));
        throw new Error(
            state?.kind === "failed"
                ? `MCP server "${name}" failed to connect: ${state.failure}`
                : `MCP server "${name}" is not connected.`,
        );
    }

    #effectiveServers(agentId: string): ReadonlyMap<string, McpCatalogServer> {
        const servers = new Map<string, McpCatalogServer>();
        const workspace = this.#agentWorkspaces.get(agentId);
        if (workspace !== undefined) {
            for (const [name, server] of this.#catalogs.get(workspaceCatalog(workspace))?.servers ??
                []) {
                servers.set(name, server);
            }
        }
        // User configuration is trusted and keeps its name when a workspace declares a collision.
        // Its stdio servers are the ones running on the agent's own machine.
        const runnerId =
            workspace === undefined ? undefined : parseWorkspaceKey(workspace).runnerId;
        const globalCatalog =
            runnerId === undefined ? GLOBAL_CATALOG : runnerGlobalCatalog(runnerId);
        // Until an agent's folder is attached, which machine runs its user-wide stdio servers is
        // not known, so they are not offered from this one.
        const attaching = workspace === undefined && this.#activations.has(agentId);
        for (const [name, server] of this.#catalogs.get(globalCatalog)?.servers ?? []) {
            servers.set(
                name,
                attaching && server.config.transport === "stdio" && server.config.enabled !== false
                    ? { config: server.config, awaitingFolder: true }
                    : server,
            );
        }
        if (this.#runsAsWorkloadUser(agentId)) return servers;
        for (const [name, server] of servers) {
            if (server.config.transport === "stdio") {
                servers.set(name, { config: server.config, unavailable: SEPARATE_USER_STDIO });
            }
        }
        return servers;
    }

    /**
     * Whether an agent's own work runs as the user its folder's stdio servers run as. Only a bot
     * with a Linux user of its own makes that untrue; an agent whose user is not known yet is
     * treated as one, so a stdio server is never offered to it by mistake.
     */
    #runsAsWorkloadUser(agentId: string): boolean {
        const workloadUser = this.#runners.workloadUser;
        if (workloadUser === undefined || !this.#runners.hasBotUsers) return true;
        return this.#agentUsers.get(agentId) === workloadUser;
    }

    /**
     * Attach an agent to its folder's catalog unless it already is. The attachment runs in a
     * lifetime of its own and is shared by everyone asking for it meanwhile; only callers that act
     * on the folder's catalog, such as a reload, wait for it.
     */
    #ensureAgentWorkspace(agentId: string): Promise<void> {
        if (this.#closed || this.#folderless.has(agentId)) return Promise.resolve();
        const workspace = this.#agentWorkspaces.get(agentId);
        if (
            workspace !== undefined &&
            this.#catalogs.has(workspaceCatalog(workspace)) &&
            this.#hasRunnerGlobalCatalog(workspace)
        )
            return Promise.resolve();
        const agents = this.#agents;
        if (agents === undefined) return Promise.resolve();
        return this.#activate(agents, agentId);
    }

    /** Start attaching an agent's folder from a turn without making the turn wait for it. */
    #attachInBackground(ctx: Context, agentId: string): void {
        this.#logActivationFailure(ctx, agentId, this.#ensureAgentWorkspace(agentId));
    }

    #logActivationFailure(ctx: Context, agentId: string, activation: Promise<void>): void {
        activation.catch((error: unknown) => {
            ctx.log.warn(
                `MCP servers for agent ${agentId} could not be prepared: ${errorMessage(error)}`,
            );
        });
    }

    /** One attachment per agent at a time, in its own named lifetime rather than the caller's. */
    #activate(agents: AgentSystemRef, agentId: string): Promise<void> {
        const pending = this.#activations.get(agentId);
        if (pending !== undefined) return pending.settled;
        const root = this.#context;
        if (this.#closed || root === undefined) return Promise.resolve();
        const token = {};
        const settled = this.#activateAgent(
            detach(root).named("mcp-agent-activation"),
            agents,
            agentId,
            token,
        ).finally(() => {
            if (this.#activations.get(agentId)?.token === token) this.#activations.delete(agentId);
        });
        this.#activations.set(agentId, { token, settled });
        return settled;
    }

    /**
     * @param token This attachment's claim. Releasing the agent withdraws it, so an attachment
     * that was still reading the agent's configuration cannot attach an agent archived meanwhile.
     */
    async #activateAgent(
        ctx: Context,
        agents: AgentSystemRef,
        agentId: string,
        token: object,
    ): Promise<void> {
        if (this.#closed) return;
        if (this.#runners.hasBotUsers) {
            const user = await this.#runners.userFor(ctx, agentId).catch(() => undefined);
            if (user === undefined) this.#agentUsers.delete(agentId);
            else this.#agentUsers.set(agentId, user);
        }
        const config = await agents.config(ctx, agentId);
        const workspace = config?.environment?.workingDirectory;
        if (workspace === undefined) {
            await this.#releaseAgent(ctx, agentId);
            this.#folderless.add(agentId);
            return;
        }
        const runnerId = config === undefined ? undefined : this.#compute.runnerOf(config);
        await this.#reloadLock.runInLock(ctx, async () => {
            if (this.#closed || this.#activations.get(agentId)?.token !== token) return;
            const normalized = workspaceKey(this.#runners, runnerId, workspace);
            if (this.#archivedWorkspaces.has(normalized)) return;
            const previous = this.#agentWorkspaces.get(agentId);
            const catalogId = workspaceCatalog(normalized);
            if (
                previous === normalized &&
                this.#catalogs.has(catalogId) &&
                this.#hasRunnerGlobalCatalog(normalized)
            )
                return;
            if (previous !== undefined && previous !== normalized) {
                await this.#releaseAgentLocked(agentId, previous);
            }
            const demand = this.#workspaceAgents.get(normalized) ?? new Set<string>();
            const first = demand.size === 0;
            this.#folderless.delete(agentId);
            this.#agentWorkspaces.set(agentId, normalized);
            demand.add(agentId);
            this.#workspaceAgents.set(normalized, demand);
            // The folder's servers start in the background; the agent sees them as connecting.
            if (first || !this.#catalogs.has(catalogId)) {
                try {
                    await this.#reconcileWorkspace(ctx, normalized, { recheck: false });
                } catch (error) {
                    this.#recordWorkspaceFailure(ctx, normalized, error);
                }
            }
            await this.#ensureRunnerGlobalCatalog(ctx, runnerId);
        });
    }

    async #releaseAgent(ctx: Context, agentId: string): Promise<void> {
        this.#rememberContext(ctx);
        await this.#reloadLock.runInLock(ctx, async () => {
            this.#activations.delete(agentId);
            this.#folderless.delete(agentId);
            const workspace = this.#agentWorkspaces.get(agentId);
            if (workspace === undefined) return;
            await this.#releaseAgentLocked(agentId, workspace);
        });
    }

    async #releaseAgentLocked(agentId: string, workspace: string): Promise<void> {
        this.#agentWorkspaces.delete(agentId);
        this.#agentUsers.delete(agentId);
        const demand = this.#workspaceAgents.get(workspace);
        demand?.delete(agentId);
        if (demand !== undefined && demand.size > 0) return;
        this.#workspaceAgents.delete(workspace);
        this.#workspaceFailures.delete(workspace);
        await this.#removeCatalog(workspaceCatalog(workspace));
        await this.#removeIdleRunnerGlobalCatalogs();
    }

    /**
     * Give a runner its copy of the user-wide catalog once one of its folders has an agent, so the
     * user's stdio servers start there rather than on another machine.
     */
    async #ensureRunnerGlobalCatalog(ctx: Context, runnerId: string | undefined): Promise<void> {
        if (runnerId === undefined || this.#catalogs.has(runnerGlobalCatalog(runnerId))) return;
        const global = this.#catalogs.get(GLOBAL_CATALOG);
        await this.#reconcileCatalogs(
            ctx,
            new Map([
                [
                    runnerGlobalCatalog(runnerId),
                    global === undefined ? {} : catalogServerConfigs(global),
                ],
            ]),
            { recheck: false },
        );
    }

    /** Stop the user's stdio servers on a runner none of whose folders has an agent any more. */
    async #removeIdleRunnerGlobalCatalogs(): Promise<void> {
        const active = this.#activeRunners();
        for (const catalogId of [...this.#catalogs.keys()]) {
            const runnerId = runnerOfGlobalCatalog(catalogId);
            if (runnerId !== undefined && !active.has(runnerId))
                await this.#removeCatalog(catalogId);
        }
    }

    /** Whether a folder on a runner has that runner's user-wide catalog; always true here. */
    #hasRunnerGlobalCatalog(workspace: string): boolean {
        const { runnerId } = parseWorkspaceKey(workspace);
        return runnerId === undefined || this.#catalogs.has(runnerGlobalCatalog(runnerId));
    }

    /** Runners holding a folder that has an agent. */
    #activeRunners(): Set<string> {
        const runners = new Set<string>();
        for (const workspace of this.#workspaceAgents.keys()) {
            const { runnerId } = parseWorkspaceKey(workspace);
            if (runnerId !== undefined) runners.add(runnerId);
        }
        return runners;
    }

    async #releaseWorkspace(ctx: Context, workspace: string): Promise<void> {
        this.#rememberContext(ctx);
        await this.#reloadLock.runInLock(ctx, async () => {
            const normalized = workspace;
            this.#archivedWorkspaces.add(normalized);
            for (const agentId of this.#workspaceAgents.get(normalized) ?? []) {
                this.#agentWorkspaces.delete(agentId);
            }
            this.#workspaceAgents.delete(normalized);
            this.#workspaceFailures.delete(normalized);
            await this.#removeCatalog(workspaceCatalog(normalized));
            await this.#removeIdleRunnerGlobalCatalogs();
        });
    }

    async #markWorkspaceActive(ctx: Context, workspace: string): Promise<void> {
        this.#rememberContext(ctx);
        await this.#reloadLock.runInLock(ctx, async () => {
            if (this.#closed) return;
            const normalized = workspace;
            this.#archivedWorkspaces.delete(normalized);
            this.#workspaceFailures.delete(normalized);
        });
    }

    async #reconcileWorkspace(
        ctx: Context,
        workspace: string,
        options: McpReconcileOptions,
    ): Promise<readonly McpStartedConnection[]> {
        if (
            this.#closed ||
            this.#archivedWorkspaces.has(workspace) ||
            (this.#workspaceAgents.get(workspace)?.size ?? 0) === 0
        ) {
            throw new Error("The workspace no longer requires an MCP catalog.");
        }
        const servers = await this.#readWorkspaceServers(workspace);
        const globalNames = new Set(this.#catalogs.get(GLOBAL_CATALOG)?.servers.keys() ?? []);
        const started = await this.#reconcileCatalogs(
            ctx,
            new Map([[workspaceCatalog(workspace), withoutServerNames(servers, globalNames)]]),
            options,
        );
        this.#workspaceFailures.delete(workspace);
        return started;
    }

    /**
     * Swap in the desired catalogs and start, in the background, every server they need that is
     * not already connected or connecting. Nothing here waits for a server: a new server is
     * visible as connecting at once, and is adopted when its attempt finishes if it is still
     * wanted then. The returned attempts are for callers that act on the catalog on purpose, such
     * as a reload, and wait for them after releasing the lock.
     */
    async #reconcileCatalogs(
        ctx: Context,
        catalogs: ReadonlyMap<string, HappyAgentConfigValues["mcpServers"]>,
        options: McpReconcileOptions,
    ): Promise<readonly McpStartedConnection[]> {
        if (
            [...catalogs.values()].some((servers) =>
                Object.values(servers).some((config) => config.transport === "http"),
            )
        ) {
            await this.#loadLogins();
        }
        const desiredCatalogs = new Map<string, McpCatalog>();
        const connectionInputs = new Map<string, McpConnectionInput>();
        for (const [catalogId, servers] of catalogs) {
            const desired = new Map<string, McpCatalogServer>();
            for (const [name, config] of Object.entries(servers)) {
                if (config.enabled === false) {
                    desired.set(name, { config });
                    continue;
                }
                // A stdio server is a process on one machine, so the same configuration on two
                // machines is two servers. An HTTP server is reached from here either way.
                if (
                    config.transport === "stdio" &&
                    catalogId === GLOBAL_CATALOG &&
                    !this.#runners.localExecution
                ) {
                    desired.set(name, { config, unavailable: NO_LOCAL_STDIO });
                    continue;
                }
                const runnerId =
                    config.transport === "stdio" ? this.#catalogRunner(catalogId) : undefined;
                const fingerprint = mcpConnectionFingerprint(config);
                if (config.transport === "http") {
                    // Anonymous servers are shared across catalogs as before; a server with a
                    // login is its catalog's own, so the login reaches only that catalog.
                    const loginCatalog = loginCatalogOf(catalogId);
                    const login: McpLoginKey = { catalog: loginCatalog, name, url: config.url };
                    const loggedIn = this.#logins.has(mcpLoginKeyId(login));
                    const connectionId = loggedIn
                        ? `login:${shortHash(mcpLoginKeyId(login))}:${fingerprint}`
                        : fingerprint;
                    desired.set(name, { config, connectionId, loginCatalog });
                    connectionInputs.set(connectionId, {
                        config,
                        name,
                        runnerId,
                        ...(loggedIn ? { login } : {}),
                    });
                    continue;
                }
                const connectionId =
                    runnerId === undefined ? fingerprint : `runner:${runnerId}:${fingerprint}`;
                desired.set(name, { config, connectionId });
                connectionInputs.set(connectionId, { config, name, runnerId });
            }
            desiredCatalogs.set(catalogId, { servers: desired });
        }

        for (const [connectionId, input] of connectionInputs) {
            const existing = this.#pool.get(connectionId);
            const kind = existing?.state.kind;
            if (kind === "connected" || kind === "connecting") continue;
            if (kind === "needs_auth" && !options.recheck) continue;
            this.#beginConnecting(ctx, connectionId, existing?.references ?? new Set(), input);
        }

        // The map writes below are synchronous, so readers see the whole old batch or the whole
        // new one rather than a global/workspace half-state.
        for (const [catalogId, desired] of desiredCatalogs) {
            for (const connectionId of catalogConnectionIds(this.#catalogs.get(catalogId))) {
                this.#pool.get(connectionId)?.references.delete(catalogId);
            }
            for (const connectionId of catalogConnectionIds(desired)) {
                this.#pool.get(connectionId)?.references.add(catalogId);
            }
        }
        for (const [catalogId, desired] of desiredCatalogs) {
            this.#catalogs.set(catalogId, desired);
        }
        await this.#closeUnreferencedConnections();
        this.#scheduleRetries();
        return [...connectionInputs.keys()].flatMap((connectionId) => {
            const state = this.#pool.get(connectionId)?.state;
            return state?.kind === "connecting" ? [{ connectionId, settled: state.settled }] : [];
        });
    }

    /**
     * Wait, outside the reload lock, for the attempts a deliberate reload started, then for the
     * tools of what they connected, so its caller sees what came of its own change.
     */
    async #settled(started: readonly McpStartedConnection[]): Promise<void> {
        await Promise.all(started.map(async (attempt) => await attempt.settled));
        await Promise.all(
            started.map(async ({ connectionId }) => {
                const state = this.#pool.get(connectionId)?.state;
                if (state?.kind === "connected") await this.#refreshTools(state.connection);
            }),
        );
    }

    async #removeCatalog(catalogId: string): Promise<void> {
        const catalog = this.#catalogs.get(catalogId);
        this.#catalogs.delete(catalogId);
        for (const connectionId of catalogConnectionIds(catalog)) {
            this.#pool.get(connectionId)?.references.delete(catalogId);
        }
        await this.#closeUnreferencedConnections();
        this.#scheduleRetries();
    }

    async #closeUnreferencedConnections(): Promise<void> {
        const closing: McpClientConnection[] = [];
        for (const [connectionId, pooled] of this.#pool) {
            if (pooled.references.size > 0) continue;
            this.#pool.delete(connectionId);
            if (pooled.state.kind === "connected") closing.push(pooled.state.connection);
        }
        await Promise.allSettled(closing.map(async (connection) => await connection.close()));
    }

    /** A live connection that ended is a failure, which is retried in the background. */
    #recordStopped(connectionId: string, connection: McpClientConnection, failure: string): void {
        const pooled = this.#pool.get(connectionId);
        if (pooled?.state.kind !== "connected" || pooled.state.connection !== connection) return;
        this.#pool.set(connectionId, {
            references: pooled.references,
            input: pooled.input,
            state: { kind: "failed", failure },
        });
        this.#scheduleRetries();
    }

    /**
     * A connected server that began refusing requests for want of a login needs one again. Its
     * connection is closed and nothing retries it until a reload, a configuration change, or a
     * login.
     */
    #recordNeedsAuth(
        connectionId: string,
        connection: McpClientConnection,
        challenge: McpNeedsAuthError,
    ): void {
        const pooled = this.#pool.get(connectionId);
        if (pooled?.state.kind !== "connected" || pooled.state.connection !== connection) return;
        this.#pool.set(connectionId, {
            references: pooled.references,
            input: pooled.input,
            state: { kind: "needs_auth", challenge },
        });
        void connection.close().catch(() => undefined);
        this.#scheduleRetries();
    }

    /** Start one pooled server, on its runner when it has one. */
    async #connect(ctx: Context, input: McpConnectionInput): Promise<McpClientConnection> {
        if (input.login !== undefined && input.config.transport === "http") {
            return await McpClientConnection.connect(
                input.name,
                input.config,
                undefined,
                this.#loginSession(input.login, input.config).fetch,
            );
        }
        return this.#runners.native(input.runnerId)
            ? await McpClientConnection.connect(input.name, input.config)
            : await McpClientConnection.connect(input.name, input.config, {
                  ctx: this.#serversLifetime(ctx),
                  machine: await this.#runners.machine(input.runnerId),
              });
    }

    /** Start one pooled server and say how it went, without throwing. */
    async #attempt(ctx: Context, input: McpConnectionInput): Promise<McpAttemptOutcome> {
        try {
            return { kind: "connected", connection: await this.#connect(ctx, input) };
        } catch (error) {
            if (error instanceof McpNeedsAuthError) return { kind: "needs_auth", challenge: error };
            return { kind: "failed", failure: errorMessage(error) };
        }
    }

    /**
     * Mark a pooled server connecting and start it in the servers' own lifetime. The attempt holds
     * no lock while it connects, and takes the reload lock only to adopt what it got.
     */
    #beginConnecting(
        callerCtx: Context,
        connectionId: string,
        references: Set<string>,
        input: McpConnectionInput,
    ): void {
        const token = {};
        const ctx = this.#serversLifetime(callerCtx);
        const settled = (async () => {
            const outcome = await this.#attempt(ctx, input);
            await this.#reloadLock.runInLock(ctx, async () => {
                const current = this.#pool.get(connectionId);
                if (
                    this.#closed ||
                    current?.state.kind !== "connecting" ||
                    current.state.token !== token ||
                    current.references.size === 0
                ) {
                    if (outcome.kind === "connected") {
                        await outcome.connection.close().catch(() => undefined);
                    }
                    return;
                }
                this.#settle(connectionId, current, outcome);
                this.#scheduleRetries();
            });
        })().catch((error: unknown) => {
            ctx.log.warn(`MCP server ${input.name} could not be started: ${errorMessage(error)}`);
        });
        this.#pool.set(connectionId, {
            references,
            input,
            state: { kind: "connecting", token, settled },
        });
    }

    /** Record how an attempt left a pooled server that still wants it. */
    #settle(connectionId: string, pooled: McpPooledConnection, outcome: McpAttemptOutcome): void {
        if (outcome.kind === "connected") {
            this.#adopt(connectionId, pooled.references, pooled.input, outcome.connection);
            return;
        }
        this.#pool.set(connectionId, {
            references: pooled.references,
            input: pooled.input,
            state: outcome,
        });
    }

    /** Make a started server the live connection behind its pool entry, and list its tools. */
    #adopt(
        connectionId: string,
        references: Set<string>,
        input: McpConnectionInput,
        connection: McpClientConnection,
    ): void {
        this.#pool.set(connectionId, {
            references,
            input,
            state: { kind: "connected", connection },
        });
        connection.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
            const listing = this.#toolListings.get(connection);
            if (listing !== undefined) listing.stale = true;
            void this.#refreshTools(connection);
        });
        connection.client.onclose = () =>
            this.#recordStopped(connectionId, connection, "The MCP server stopped.");
        connection.onauthrequired = (challenge) =>
            this.#recordNeedsAuth(connectionId, connection, challenge);
        // Listed now, so the first turn that needs the tools usually finds them waiting.
        void this.#refreshTools(connection);
    }

    /**
     * Keep exactly one retry, pending or running, for every failed server a catalog still uses, and
     * none for anything else. A server that failed at startup or stopped later would otherwise stay
     * failed until someone reloaded by hand, while sessions that had already found its tools lost
     * them.
     */
    #scheduleRetries(): void {
        for (const [connectionId, retry] of this.#retries) {
            const pooled = this.#pool.get(connectionId);
            if (this.#closed || pooled?.state.kind !== "failed" || pooled.references.size === 0) {
                clearTimeout(retry.timer);
                this.#retries.delete(connectionId);
            }
        }
        if (this.#closed || this.#context === undefined) return;
        for (const [connectionId, pooled] of this.#pool) {
            if (pooled.state.kind !== "failed" || pooled.references.size === 0) continue;
            if (!this.#retries.has(connectionId)) this.#armRetry(connectionId, 0);
        }
    }

    #armRetry(connectionId: string, attempts: number): void {
        const delay = Math.min(RETRY_MAX_DELAY_MS, RETRY_FIRST_DELAY_MS * 2 ** attempts);
        const timer = setTimeout(() => void this.#retry(connectionId), delay);
        timer.unref();
        this.#retries.set(connectionId, { attempts, timer });
    }

    /**
     * Start a failed server again off every caller's path, and adopt it only if it is still failed
     * and still used once it is up: a reload may have started it meanwhile, or released it.
     */
    async #retry(connectionId: string): Promise<void> {
        const scheduled = this.#retries.get(connectionId);
        const pooled = this.#pool.get(connectionId);
        const root = this.#context;
        if (this.#closed || scheduled === undefined || pooled?.state.kind !== "failed") return;
        if (root === undefined) return;
        // The entry stays while the attempt runs, so nothing arms a second attempt beside it.
        const running: McpRetry = { attempts: scheduled.attempts };
        this.#retries.set(connectionId, running);
        this.#retriesContext ??= detach(root).named("mcp-server-retries");
        const ctx = this.#retriesContext;
        const outcome = await this.#attempt(ctx, pooled.input);
        await this.#reloadLock.runInLock(ctx, async () => {
            const current = this.#pool.get(connectionId);
            const owned = this.#retries.get(connectionId) === running;
            if (owned) this.#retries.delete(connectionId);
            if (this.#closed || current?.state.kind !== "failed" || current.references.size === 0) {
                if (outcome.kind === "connected") {
                    await outcome.connection.close().catch(() => undefined);
                }
            } else {
                this.#settle(connectionId, current, outcome);
                if (outcome.kind === "connected") {
                    ctx.log.info(`MCP server ${current.input.name} connected again.`);
                } else if (outcome.kind === "failed" && owned) {
                    this.#armRetry(connectionId, running.attempts + 1);
                }
            }
            this.#scheduleRetries();
        });
    }

    /** Fail every server on a runner that is not connected, and stop what it holds of them. */
    #failServersOnAbsentRunners(): void {
        for (const [connectionId, pooled] of this.#pool) {
            const runnerId = /^runner:([^:]+):/u.exec(connectionId)?.[1];
            if (
                pooled.state.kind !== "connected" ||
                runnerId === undefined ||
                this.#connectedRunners.has(runnerId)
            ) {
                continue;
            }
            const connection = pooled.state.connection;
            const failure = `The runner ${this.#runners.displayName(runnerId)} is not connected.`;
            this.#recordStopped(connectionId, connection, failure);
            void connection.close().catch(() => undefined);
        }
    }

    #rememberContext(ctx: Context): void {
        this.#context ??= ctx;
    }

    /** The lifetime of servers and their work, which outlive whatever request first needed them. */
    #serversLifetime(ctx?: Context): Context {
        const root = this.#context ?? ctx;
        if (root === undefined) throw new Error("The MCP module has not started.");
        this.#serversContext ??= detach(root).named("mcp-servers");
        return this.#serversContext;
    }

    /** The runner a catalog's stdio servers start on, or undefined for this machine. */
    #catalogRunner(catalogId: string): string | undefined {
        if (catalogId === GLOBAL_CATALOG) return undefined;
        const runnerId = runnerOfGlobalCatalog(catalogId);
        if (runnerId !== undefined) return runnerId;
        return parseWorkspaceKey(catalogId.slice(WORKSPACE_CATALOG_PREFIX.length)).runnerId;
    }

    /** A workspace's own catalog, read from the machine the workspace is on. */
    async #readWorkspaceServers(workspace: string): Promise<HappyAgentConfigValues["mcpServers"]> {
        const { path, runnerId } = parseWorkspaceKey(workspace);
        return await this.#config.readWorkspaceMcpServers(
            path,
            await this.#workspaceMachine(runnerId),
        );
    }

    /** The machine a workspace's files are reached through, or undefined for this daemon's own. */
    async #workspaceMachine(runnerId: string | undefined) {
        return this.#runners.native(runnerId) ? undefined : await this.#runners.machine(runnerId);
    }

    /** The active workspace an agent belongs to, for changes that act on its own catalog. */
    #attachedWorkspace(agentId: string): string {
        const workspace = this.#agentWorkspaces.get(agentId);
        if (
            workspace === undefined ||
            this.#archivedWorkspaces.has(workspace) ||
            !this.#workspaceAgents.get(workspace)?.has(agentId)
        ) {
            throw new Error("This session is not attached to an active workspace directory.");
        }
        return workspace;
    }

    #assertOpen(): void {
        if (this.#closed) throw new Error("The MCP module is closed.");
    }

    #recordWorkspaceFailure(ctx: Context, workspace: string, error: unknown): void {
        const message = errorMessage(error);
        if (this.#workspaceFailures.get(workspace) === message) return;
        this.#workspaceFailures.set(workspace, message);
        ctx.log.warn(`Workspace MCP discovery failed for ${workspace}: ${message}`);
    }

    #requestOptions(ctx: Context, configuredTimeout: number | undefined) {
        const timeout = configuredTimeout ?? 60_000;
        return {
            timeout,
            maxTotalTimeout: timeout,
            ...(ctx.lifetime === undefined ? {} : { signal: ctx.lifetime }),
        };
    }

    /**
     * Every provider request and tool execution reads the tools, so one listing is shared by every
     * session on the connection. Reading it never waits: a missing or out-of-date listing is
     * refreshed in the background, and the reader takes what is there now.
     */
    #toolListing(connection: McpClientConnection): McpToolListing {
        let listing = this.#toolListings.get(connection);
        if (listing === undefined) {
            listing = { generation: this.#toolGeneration, stale: true };
            this.#toolListings.set(connection, listing);
        }
        if (listing.stale || listing.generation !== this.#toolGeneration) {
            void this.#refreshTools(connection);
        }
        return listing;
    }

    /**
     * List a connection's tools in the servers' lifetime, joining a listing already under way. It
     * is not bound to whoever asked, who only stops waiting for it, and it never rejects: a
     * failure is kept on the listing and the next read tries again.
     */
    #refreshTools(connection: McpClientConnection): Promise<void> {
        let listing = this.#toolListings.get(connection);
        if (listing === undefined) {
            listing = { generation: this.#toolGeneration, stale: true };
            this.#toolListings.set(connection, listing);
        }
        if (listing.pending !== undefined) return listing.pending;
        const target = listing;
        target.stale = false;
        target.generation = this.#toolGeneration;
        const pending = this.#listTools(this.#serversLifetime(), connection)
            .then(
                (tools) => {
                    target.tools = tools;
                    delete target.failure;
                },
                (error: unknown) => {
                    if (target.tools === undefined) target.failure = errorMessage(error);
                    target.stale = true;
                },
            )
            .finally(() => {
                delete target.pending;
            });
        target.pending = pending;
        return pending;
    }

    /** A connection's tools for a caller that asked for them, waiting only as long as it lasts. */
    async #allTools(ctx: Context, connection: McpClientConnection): Promise<McpTool[]> {
        const listing = this.#toolListing(connection);
        if (
            listing.tools !== undefined &&
            !listing.stale &&
            listing.generation === this.#toolGeneration
        ) {
            return listing.tools;
        }
        const refresh = this.#refreshTools(connection);
        const lifetime = ctx.lifetime;
        if (lifetime === undefined) {
            await refresh;
        } else {
            lifetime.throwIfAborted();
            let stop = (): void => {};
            const stopped = new Promise<never>((_, reject) => {
                stop = () => reject(lifetime.reason);
                lifetime.addEventListener("abort", stop, { once: true });
            });
            try {
                await Promise.race([refresh, stopped]);
            } finally {
                lifetime.removeEventListener("abort", stop);
            }
        }
        if (listing.tools !== undefined) return listing.tools;
        throw new Error(listing.failure ?? "The MCP server did not list its tools.");
    }

    async #listTools(ctx: Context, connection: McpClientConnection): Promise<McpTool[]> {
        const values = await collectMcpPages(
            async (cursor) =>
                await connection.client.listTools(
                    cursor === undefined ? {} : { cursor },
                    this.#requestOptions(ctx, connection.config.toolTimeoutMs),
                ),
            (page) => page.tools,
        );
        const tools: McpTool[] = [];
        for (const tool of values) {
            const candidate = {
                name: tool.name,
                ...(tool.description === undefined ? {} : { description: tool.description }),
                inputSchema: structuredClone(tool.inputSchema),
                ...(tool.title === undefined ? {} : { title: tool.title }),
                ...(tool._meta === undefined ? {} : { _meta: structuredClone(tool._meta) }),
            };
            if (!Value.Check(mcpToolSchema, candidate)) {
                ctx.log.warn(
                    `The ${tool.name} tool from ${connection.name} is unavailable: its definition is invalid or exceeds the MCP limits.`,
                );
                continue;
            }
            tools.push(candidate);
        }
        return tools;
    }

    async #allResources(ctx: Context, connection: McpClientConnection) {
        const values = await collectMcpPages(
            async (cursor) =>
                await connection.client.listResources(
                    cursor === undefined ? {} : { cursor },
                    this.#requestOptions(ctx, connection.config.toolTimeoutMs),
                ),
            (page) => page.resources,
        );
        return values.map((resource) => ({
            uri: resource.uri,
            name: resource.name,
            ...(resource.title === undefined ? {} : { title: resource.title }),
            ...(resource.description === undefined ? {} : { description: resource.description }),
            ...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
            ...(resource.annotations === undefined
                ? {}
                : { annotations: structuredClone(resource.annotations) }),
            ...(resource._meta === undefined ? {} : { _meta: structuredClone(resource._meta) }),
        }));
    }

    async #allResourceTemplates(ctx: Context, connection: McpClientConnection) {
        const values = await collectMcpPages(
            async (cursor) =>
                await connection.client.listResourceTemplates(
                    cursor === undefined ? {} : { cursor },
                    this.#requestOptions(ctx, connection.config.toolTimeoutMs),
                ),
            (page) => page.resourceTemplates,
        );
        return values.map((template) => ({
            uriTemplate: template.uriTemplate,
            name: template.name,
            ...(template.title === undefined ? {} : { title: template.title }),
            ...(template.description === undefined ? {} : { description: template.description }),
            ...(template.mimeType === undefined ? {} : { mimeType: template.mimeType }),
            ...(template.annotations === undefined
                ? {}
                : { annotations: structuredClone(template.annotations) }),
            ...(template._meta === undefined ? {} : { _meta: structuredClone(template._meta) }),
        }));
    }

    async #allPrompts(ctx: Context, connection: McpClientConnection) {
        const values = await collectMcpPages(
            async (cursor) =>
                await connection.client.listPrompts(
                    cursor === undefined ? {} : { cursor },
                    this.#requestOptions(ctx, connection.config.toolTimeoutMs),
                ),
            (page) => page.prompts,
        );
        return values.map((prompt) => ({
            name: prompt.name,
            ...(prompt.title === undefined ? {} : { title: prompt.title }),
            ...(prompt.description === undefined ? {} : { description: prompt.description }),
            ...(prompt.arguments === undefined
                ? {}
                : { arguments: structuredClone(prompt.arguments) }),
            ...(prompt._meta === undefined ? {} : { _meta: structuredClone(prompt._meta) }),
        }));
    }

    /**
     * Puts an elicitation in front of the person as an ordinary question on the asking agent.
     *
     * The question is the person's alone: no agent tool answers a question, and nothing here
     * answers one. When the server withdraws its request, the connection ends, or the turn stops,
     * the question is withdrawn too, so it never waits on an answer nobody will read.
     */
    #mcpUserInputService(
        ctx: Context,
        agentId: string,
        server: string,
        serverSignal: AbortSignal,
    ): McpUserInputService {
        const signal =
            ctx.lifetime === undefined
                ? serverSignal
                : AbortSignal.any([serverSignal, ctx.lifetime]);
        return {
            request: async (request: McpUserInputRequest): Promise<McpUserInputResponse> => {
                if (signal.aborted) return { status: "cancelled" };
                const pending = await this.#userInput.askForPermission(
                    ctx,
                    agentId,
                    {
                        context: request.context,
                        questions: request.questions.map((question) => ({
                            id: question.id,
                            header: question.header,
                            question: question.question,
                            ...(question.options.length === 0
                                ? {}
                                : {
                                      options: question.options.map((option) => ({
                                          label: option.label,
                                          description: option.description,
                                      })),
                                      multiSelect: question.multiSelect,
                                  }),
                        })),
                    },
                    {
                        source: "mcp_elicitation",
                        server,
                        serverTitle: boundServerTitle(humanizeMcpName(server)),
                    },
                );
                const withdraw = (): void => {
                    this.#userInput
                        .cancel(ctx, agentId, {
                            requestId: pending.id,
                            reason: `${humanizeMcpName(server)} no longer needs an answer.`,
                        })
                        .catch((error: unknown) => {
                            ctx.log.warn(
                                `Could not withdraw the question from MCP server ${server}: ${errorMessage(error)}`,
                            );
                        });
                };
                signal.addEventListener("abort", withdraw, { once: true });
                if (signal.aborted) withdraw();
                const settled = await this.#userInput
                    .wait(ctx, agentId, pending.id)
                    .finally(() => signal.removeEventListener("abort", withdraw));
                if (settled.status !== "answered") return { status: "cancelled" };
                return {
                    status: "answered",
                    answers: Object.fromEntries(
                        Object.entries(settled.answers ?? {}).map(([id, answer]) => [
                            id,
                            userInputAnswerStrings(answer),
                        ]),
                    ),
                };
            },
        };
    }
}

export function assertMcpModuleOptions(value: unknown): asserts value is McpModuleOptions {
    if (!Value.Check(mcpModuleOptionsSchema, value)) {
        throw new Error("MCP module options are invalid.");
    }
}

function assertAgentId(agentId: string): string {
    if (!Value.Check(mcpAgentIdSchema, agentId)) {
        throw new Error("MCP agent identity is invalid.");
    }
    return agentId;
}

function assertUnique(values: readonly string[], kind: string): void {
    if (new Set(values).size !== values.length) {
        throw new Error(`MCP server returned duplicate ${kind} identities.`);
    }
}

async function collectMcpPages<Page extends { readonly nextCursor?: string | undefined }, Item>(
    fetchPage: (cursor: string | undefined) => Promise<Page>,
    items: (page: Page) => readonly Item[],
): Promise<Item[]> {
    const collected: Item[] = [];
    let cursor: string | undefined;
    for (let count = 0; count < MAX_MCP_PAGE_SIZE; count += 1) {
        const page = await fetchPage(cursor);
        collected.push(...items(page));
        if (collected.length > MAX_MCP_TOTAL_TOOLS) {
            throw new Error("MCP catalog exceeded its configured bound.");
        }
        if (page.nextCursor === undefined) return collected;
        if (page.nextCursor === cursor) throw new Error("MCP cursor did not advance.");
        cursor = page.nextCursor;
    }
    throw new Error("MCP pagination exceeded its configured bound.");
}

function pageFrom<const Key extends string, Item>(
    values: readonly Item[],
    cursor: string | undefined,
    limit: number,
    key: Key,
): { readonly [K in Key]: readonly Item[] } & { readonly nextCursor?: string } {
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > values.length) {
        throw new Error("MCP cursor is invalid.");
    }
    const selected = values.slice(offset, offset + limit);
    return {
        [key]: selected,
        ...(offset + selected.length < values.length
            ? { nextCursor: String(offset + selected.length) }
            : {}),
    } as { readonly [K in Key]: readonly Item[] } & { readonly nextCursor?: string };
}

function userInputAnswerStrings(answer: unknown): string[] {
    if (typeof answer === "string") return [answer];
    if (!isRecord(answer)) return [];
    const selected = Array.isArray(answer.selectedOptions)
        ? answer.selectedOptions.filter((value): value is string => typeof value === "string")
        : [];
    return typeof answer.text === "string" ? [...selected, answer.text] : selected;
}

const WORKSPACE_CATALOG_PREFIX = "workspace:";

/**
 * One workspace folder: its path on this machine, or its runner and its path there, each resolved
 * by its own machine's path rules. The same path on two machines is two folders.
 */
function workspaceKey(runners: RunnersModule, runnerId: string | undefined, path: string): string {
    if (path.length === 0 || path.length > 4_096) throw new Error("Workspace path is invalid.");
    const resolved = runners.paths(runnerId).resolve(path);
    return runnerId === undefined ? resolved : `runner:${runnerId}:${resolved}`;
}

function parseWorkspaceKey(key: string): { readonly path: string; readonly runnerId?: string } {
    const match = /^runner:([a-z][a-z0-9_-]{0,63}):(.+)$/su.exec(key);
    return match === null
        ? { path: key }
        : { path: match[2] as string, runnerId: match[1] as string };
}

function workspaceCatalog(workspace: string): string {
    return `${WORKSPACE_CATALOG_PREFIX}${workspace}`;
}

const RUNNER_GLOBAL_CATALOG_PREFIX = "global:runner:";

/** The user-wide catalog as it applies on one runner. */
function runnerGlobalCatalog(runnerId: string): string {
    return `${RUNNER_GLOBAL_CATALOG_PREFIX}${runnerId}`;
}

function runnerOfGlobalCatalog(catalogId: string): string | undefined {
    return catalogId.startsWith(RUNNER_GLOBAL_CATALOG_PREFIX)
        ? catalogId.slice(RUNNER_GLOBAL_CATALOG_PREFIX.length)
        : undefined;
}

function catalogConnectionIds(catalog: McpCatalog | undefined): ReadonlySet<string> {
    return new Set(
        [...(catalog?.servers.values() ?? [])].flatMap((server) =>
            server.connectionId === undefined ? [] : [server.connectionId],
        ),
    );
}

function withoutServerNames(
    servers: HappyAgentConfigValues["mcpServers"],
    omitted: ReadonlySet<string>,
): HappyAgentConfigValues["mcpServers"] {
    return Object.fromEntries(Object.entries(servers).filter(([name]) => !omitted.has(name)));
}

function catalogServerConfigs(catalog: McpCatalog): HappyAgentConfigValues["mcpServers"] {
    return Object.fromEntries(
        [...catalog.servers.entries()].map(([name, server]) => [name, server.config]),
    );
}

/** A display name kept within the bound a permission request allows. */
function boundServerTitle(title: string): string {
    return title.length <= MAX_MCP_SERVER_NAME_LENGTH
        ? title
        : `${title.slice(0, MAX_MCP_SERVER_NAME_LENGTH - 1).trimEnd()}…`;
}

/** What the model is told about a server that needs a login, so it can offer one. */
function needsAuthMessage(name: string, challenge: McpNeedsAuthError): string {
    const need = challenge.insufficientScope
        ? `MCP server "${name}" needs a login with more access than the current one.`
        : `MCP server "${name}" needs a login.`;
    return `${need} The person can ask you to log in to it; when they do, call start_mcp_auth with server "${name}", which sends them a sign-in link. It is not retried on its own; a login, a reload, or a configuration change checks it again.`;
}

/** Who a login made in this catalog serves, in words a person reads. */
function loginAudience(loginCatalog: string): string {
    if (loginCatalog === USER_LOGIN_CATALOG) {
        return "every agent that uses your user-wide MCP servers";
    }
    const { path } = parseWorkspaceKey(loginCatalog.slice(WORKSPACE_CATALOG_PREFIX.length));
    return `every agent working in ${path}`;
}

/** Why Happy does not log in to a stdio server, and how the person can. */
function stdioLoginMessage(name: string): string {
    return `MCP server "${name}" is a stdio server: Happy starts its program, and the program signs in by itself, as wrappers such as mcp-remote do. Log in by running that same command once in a terminal on the machine that runs it, outside Happy, and complete the sign-in it opens. Happy starts a server that stopped or failed again in the background, so the login is picked up on its next start; reloading the MCP servers starts it at once.`;
}

/** The OAuth client mcp.toml configures for a server, read from its environment variables. */
function configuredLoginClient(
    config: Extract<McpServerConfig, { transport: "http" }>,
): McpLoginClient | undefined {
    if (config.oauthClientIdEnvVar === undefined) return undefined;
    const clientId = process.env[config.oauthClientIdEnvVar]?.trim();
    if (clientId === undefined || clientId.length === 0) {
        throw new McpLoginError(
            `The environment variable ${config.oauthClientIdEnvVar}, which mcp.toml names for this server's OAuth client ID, is not set.`,
        );
    }
    const secretVariable = config.oauthClientSecretEnvVar;
    const clientSecret =
        secretVariable === undefined ? undefined : process.env[secretVariable]?.trim();
    if (secretVariable !== undefined && (clientSecret === undefined || clientSecret.length === 0)) {
        throw new McpLoginError(
            `The environment variable ${secretVariable}, which mcp.toml names for this server's OAuth client secret, is not set.`,
        );
    }
    return {
        client_id: clientId,
        ...(clientSecret === undefined ? {} : { client_secret: clientSecret }),
    };
}

function configuredLoginClientOrUndefined(
    config: Extract<McpServerConfig, { transport: "http" }>,
): McpLoginClient | undefined {
    try {
        return configuredLoginClient(config);
    } catch {
        return undefined;
    }
}

/** The catalog a login to an HTTP server in this catalog belongs to. */
function loginCatalogOf(catalogId: string): string {
    return catalogId === GLOBAL_CATALOG || runnerOfGlobalCatalog(catalogId) !== undefined
        ? USER_LOGIN_CATALOG
        : catalogId;
}

function shortHash(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function errorMessage(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return text.replaceAll(/\s+/gu, " ").slice(0, 2_000) || "Connection failed.";
}

function isMcpToolAllowed(server: McpToolPolicy, name: string): boolean {
    return (
        (server.enabledTools === undefined || server.enabledTools.includes(name)) &&
        !server.disabledTools?.includes(name)
    );
}

function assertCursorProgress(
    requested: string | undefined,
    next: string | undefined,
    visibleCount: number,
): void {
    if (next === undefined) return;
    if (visibleCount === 0 || next === requested) {
        throw new Error("MCP server returned a non-advancing cursor.");
    }
}

function formatIdentityRows(
    identities: readonly string[],
    suffixes: readonly (string | undefined)[],
    nextCursor: string | undefined,
    maximumCharacters: number,
    empty: string,
): string {
    const continuation =
        nextCursor === undefined ? undefined : `More results at cursor ${nextCursor}.`;
    const rows = identities.map((identity, index) => `${identity}${suffixes[index] ?? ""}`);
    let output = rows.length === 0 ? empty : rows.join("\n");
    if (continuation !== undefined) output = `${output}\n${continuation}`;
    if (output.length <= maximumCharacters) return output;

    const visible = identities.map((identity) => identity);
    let size = 0;
    let count = 0;
    for (const row of visible) {
        const nextSize = size + row.length + (count === 0 ? 0 : 1);
        const continuationSize = continuation === undefined ? 0 : continuation.length + 1;
        if (nextSize + continuationSize > maximumCharacters) break;
        count += 1;
        size = nextSize;
    }
    if (count === 0) {
        throw new Error("MCP model output cannot fit a complete identity.");
    }
    const compact = visible.slice(0, count);
    for (let index = 0; index < count; index += 1) {
        const suffix = suffixes[index];
        if (suffix === undefined) continue;
        const candidate = [...compact];
        candidate[index] = `${candidate[index]}${suffix}`;
        const candidateOutput =
            continuation === undefined
                ? candidate.join("\n")
                : `${candidate.join("\n")}\n${continuation}`;
        if (candidateOutput.length <= maximumCharacters) {
            compact[index] = candidate[index]!;
        }
    }
    if (continuation !== undefined) {
        const withContinuation = `${compact.join("\n")}\n${continuation}`;
        if (withContinuation.length > maximumCharacters) {
            throw new Error("MCP model output cannot fit its continuation cursor.");
        }
        return withContinuation;
    }
    return compact.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a server-supplied schema is an object at the root, which is what every model provider
 * requires of a tool's parameters.
 */
function isObjectRootedSchema(schema: unknown): boolean {
    return isRecord(schema) && schema.type === "object";
}
