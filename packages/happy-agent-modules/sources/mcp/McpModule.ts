import { sql } from "drizzle-orm";
import {
    agentDatabaseRun,
    type AgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { asyncLock, type AsyncLock, type Context } from "@steve.kite/stdlib";

import { ConfigModule, type HappyAgentConfigValues } from "../config/index.js";
import { UserInputModule } from "../userInput/index.js";

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
    mcpToolResultSchema,
    mcpAgentIdSchema,
    mcpElicitationRequestSchema,
    type McpCallToolInput,
    type McpElicitationRequest,
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
import { McpClientConnection } from "./McpClientConnection.js";
import { createMcpConfigurationTools } from "./createMcpConfigurationTools.js";
import { createMcpProtocolTools } from "./createMcpProtocolTools.js";
import { createMcpTool } from "./createMcpTool.js";
import { handleMcpElicitation, type McpUserInputService } from "./handleMcpElicitation.js";
import {
    assertPromptPage,
    assertResourcePage,
    assertResourceTemplatePage,
    assertServerPage,
    assertToolPage,
} from "./mcpPageAssertions.js";
import { listMcpServersTool } from "./tools/list_mcp_servers.js";
import { mcpResultToContentBlocks } from "./mcpResultToContentBlocks.js";
import { mergeMcpTools } from "./mergeMcpTools.js";

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_OUTPUT_CHARACTERS = 12_000;
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

/**
 * One shared MCP capability serves every agent and owns the live clients, protocol operations,
 * validation, naming, permission declarations, and model rendering.
 */
export class McpModule implements AgentModule {
    readonly name = "mcp";
    readonly migrations = [mcpMigration];

    readonly #config: ConfigModule;
    readonly #userInput: UserInputModule;
    readonly #maxPageSize: number;
    readonly #maxOutputCharacters: number;
    readonly #reloadLock: AsyncLock = asyncLock({ reentry: "allow" });
    #connections = new Map<string, McpClientConnection>();
    #servers: HappyAgentConfigValues["mcpServers"] = {};
    #failures = new Map<string, string>();
    #initialReload: Promise<void> | undefined;

    constructor(config: ConfigModule, userInput: UserInputModule, options: McpModuleOptions = {}) {
        if (!Value.Check(mcpModuleOptionsSchema, options)) {
            throw new Error("MCP module options are invalid.");
        }
        this.#config = config;
        this.#userInput = userInput;
        this.#maxPageSize = options.maxPageSize ?? DEFAULT_PAGE_SIZE;
        this.#maxOutputCharacters = options.maxOutputCharacters ?? DEFAULT_OUTPUT_CHARACTERS;
    }

    readonly #hooks: AgentModuleHooks = {
        /**
         * Keep a durable, bounded server index for prompt projections and restart diagnostics.
         * The live connection catalog remains authoritative; this snapshot is only written
         * through the caller's Agent Storage transaction.
         */
        beforeAgentLoop: async (ctx: Context, scope: AgentModuleScope): Promise<void> => {
            await this.#initialReload;
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
         */
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            await this.#initialReload;
            const agentId = assertAgentId(scope.agent.id);
            const servers = await this.#listAllServers(ctx, agentId, scope.agent.permissionMode);
            const connected = servers.filter((server) => server.status === "connected");
            const loadedTools: AnyAgentTool[] = [];
            for (const server of connected) {
                const tools = await this.#listAllTools(ctx, agentId, server.name);
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
                    loadedTools.push(createMcpTool(this, agentId, server.name, tool));
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
                ...merged.tools,
                ...protocolTools,
            ];
        },
    };

    readonly beforeStart = (ctx: Context): AgentModuleHooks => {
        this.#initialReload ??= this.reload(ctx).catch((error: unknown) => {
            ctx.log.warn(`Initial MCP discovery failed: ${errorMessage(error)}`);
        });
        return this.#hooks;
    };

    /** Reread mcp.toml and atomically replace the live connection catalog. */
    async reload(ctx: Context): Promise<void> {
        await this.#reloadLock.runInLock(ctx, async () => {
            const servers = await this.#config.readMcpServers();
            const connected = await Promise.all(
                Object.entries(servers).map(async ([name, server]) => {
                    if (server.enabled === false) return { name } as const;
                    try {
                        return {
                            name,
                            connection: await McpClientConnection.connect(name, server),
                        } as const;
                    } catch (error) {
                        return { name, error: errorMessage(error) } as const;
                    }
                }),
            );
            const nextConnections = new Map<string, McpClientConnection>();
            const nextFailures = new Map<string, string>();
            for (const result of connected) {
                if ("connection" in result) nextConnections.set(result.name, result.connection);
                if ("error" in result) nextFailures.set(result.name, result.error);
            }
            const previous = this.#connections;
            this.#servers = servers;
            this.#connections = nextConnections;
            this.#failures = nextFailures;
            await Promise.allSettled(
                [...previous.values()].map(async (entry) => await entry.close()),
            );
        });
    }

    async configureServer(
        ctx: Context,
        name: string,
        server: HappyAgentConfigValues["mcpServers"][string] | undefined,
    ): Promise<void> {
        await this.#config.updateMcpServer(ctx, name, server);
        await this.reload(ctx);
    }

    async close(): Promise<void> {
        const connections = this.#connections;
        this.#connections = new Map();
        await Promise.allSettled(
            [...connections.values()].map(async (entry) => await entry.close()),
        );
    }

    async listServerPage(
        ctx: Context,
        agentId: string,
        query: McpServerPageQuery = {},
        permissionMode: McpPermissionMode = "auto",
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
        const all = await Promise.all(
            Object.entries(this.#servers)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(async ([name, config]): Promise<McpServerSummary> => {
                    if (config.enabled === false) {
                        return { name, status: "disabled", toolCount: 0 };
                    }
                    const connection = this.#connections.get(name);
                    if (connection === undefined) {
                        return {
                            name,
                            status: "failed",
                            toolCount: 0,
                            errorMessage: this.#failures.get(name) ?? "Connection failed.",
                        };
                    }
                    try {
                        const tools = await this.#allTools(ctx, connection);
                        const capabilities = connection.client.getServerCapabilities();
                        return {
                            name,
                            status: "connected",
                            toolCount: tools.length,
                            ...(config.enabledTools === undefined
                                ? {}
                                : { enabledTools: [...config.enabledTools] }),
                            ...(config.disabledTools === undefined
                                ? {}
                                : { disabledTools: [...config.disabledTools] }),
                            ...(capabilities?.prompts === undefined ? {} : { promptSupport: true }),
                            ...(capabilities?.resources === undefined
                                ? {}
                                : { resourceSupport: true }),
                        };
                    } catch (error) {
                        return {
                            name,
                            status: "failed",
                            toolCount: 0,
                            errorMessage: errorMessage(error),
                        };
                    }
                }),
        );
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
            await this.#allTools(ctx, this.#connection(normalized.server)),
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
            await this.#allResources(ctx, this.#connection(normalized.server)),
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
            await this.#allResourceTemplates(ctx, this.#connection(normalized.server)),
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
            await this.#allPrompts(ctx, this.#connection(normalized.server)),
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
        const raw = await this.#connection(input.server).callTool(ctx, input, async (request) => {
            if (!Value.Check(mcpElicitationRequestSchema, request)) return { action: "decline" };
            return await handleMcpElicitation(
                ctx,
                request,
                this.#mcpUserInputService(ctx, agentId),
            );
        });
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
        const connection = this.#connection(input.server);
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
        const connection = this.#connection(input.server);
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

    async #listAllTools(
        ctx: Context,
        agentId: string,
        server: string,
    ): Promise<readonly McpTool[]> {
        const tools: McpTool[] = [];
        let cursor: string | undefined;
        for (let pageCount = 0; pageCount < MAX_MCP_PAGE_SIZE; pageCount += 1) {
            const page = await this.listToolPage(ctx, agentId, {
                server,
                ...(cursor === undefined ? {} : { cursor }),
                limit: this.#maxPageSize,
            });
            tools.push(...page.tools);
            if (page.nextCursor === undefined) {
                assertUnique(
                    tools.map((tool) => tool.name),
                    "tool",
                );
                return tools;
            }
            cursor = page.nextCursor;
        }
        throw new Error("MCP tool pagination exceeded its bound.");
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

    #connection(name: string): McpClientConnection {
        const connection = this.#connections.get(name);
        if (connection !== undefined) return connection;
        const failure = this.#failures.get(name);
        throw new Error(
            failure === undefined
                ? `MCP server "${name}" is not connected.`
                : `MCP server "${name}" failed to connect: ${failure}`,
        );
    }

    #requestOptions(ctx: Context, configuredTimeout: number | undefined) {
        const timeout = configuredTimeout ?? 60_000;
        return {
            timeout,
            maxTotalTimeout: timeout,
            ...(ctx.lifetime === undefined ? {} : { signal: ctx.lifetime }),
        };
    }

    async #allTools(ctx: Context, connection: McpClientConnection): Promise<McpTool[]> {
        const values = await collectMcpPages(
            async (cursor) =>
                await connection.client.listTools(
                    cursor === undefined ? {} : { cursor },
                    this.#requestOptions(ctx, connection.config.toolTimeoutMs),
                ),
            (page) => page.tools,
        );
        return values.map((tool) => ({
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            inputSchema: structuredClone(tool.inputSchema),
            ...(tool.title === undefined ? {} : { title: tool.title }),
            ...(tool._meta === undefined ? {} : { _meta: structuredClone(tool._meta) }),
        }));
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

    #mcpUserInputService(ctx: Context, agentId: string): McpUserInputService {
        return {
            request: async (request: McpUserInputRequest): Promise<McpUserInputResponse> => {
                const pending = await this.#userInput.ask(
                    ctx,
                    agentId,
                    {
                        context: "An MCP server is asking for additional input.",
                        questions: request.questions.map((question) => ({
                            id: question.id,
                            header: question.header,
                            question: question.question.slice(0, 4_000),
                            ...(question.options.length === 0
                                ? {}
                                : {
                                      options: question.options.map((option) => ({
                                          label: option.label,
                                          description: option.description.slice(0, 2_000),
                                      })),
                                      multiSelect: question.multiSelect,
                                  }),
                        })),
                    },
                    request.requestId,
                );
                const settled = await this.#userInput.wait(ctx, agentId, pending.id);
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
