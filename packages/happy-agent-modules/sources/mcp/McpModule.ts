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
import type { Context } from "@steve.kite/stdlib";

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
} from "./Mcp.js";
import { assertMcpHost, mcpHostCallOptionsSchema, mcpHostSchema, type McpHost } from "./McpHost.js";
import { createMcpProtocolTools } from "./createMcpProtocolTools.js";
import { createMcpTool } from "./createMcpTool.js";
import {
    handleMcpElicitation,
    mcpUserInputServiceSchema,
    type McpUserInputService,
} from "./handleMcpElicitation.js";
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
        host: mcpHostSchema,
        maxOutputCharacters: Type.Optional(outputCharactersSchema),
        maxPageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_MCP_PAGE_SIZE })),
        userInput: Type.Optional(mcpUserInputServiceSchema),
    },
    { additionalProperties: false },
);
export type McpModuleOptions = Static<typeof mcpModuleOptionsSchema>;

/**
 * One shared MCP capability serves every agent.  Happy Agent supplies the host; this class owns the
 * provider-neutral operations, validation, naming, permission declarations, and model rendering.
 */
export class McpModule implements AgentModule {
    readonly name = "mcp";
    readonly migrations = [mcpMigration];

    readonly #host: McpHost;
    readonly #userInput: McpUserInputService | undefined;
    readonly #maxPageSize: number;
    readonly #maxOutputCharacters: number;

    constructor(options: McpModuleOptions) {
        const checked = runtimeOptions(options);
        if (!Value.Check(mcpModuleOptionsSchema, checked)) {
            throw new Error("MCP module options are invalid.");
        }
        assertMcpHost(checked.host);
        this.#host = options.host;
        this.#userInput = options.userInput;
        this.#maxPageSize = options.maxPageSize ?? DEFAULT_PAGE_SIZE;
        this.#maxOutputCharacters = options.maxOutputCharacters ?? DEFAULT_OUTPUT_CHARACTERS;
    }

    readonly #hooks: AgentModuleHooks = {
        /**
         * Keep a durable, bounded server index for prompt projections and restart diagnostics.
         * The host remains authoritative for live calls; this snapshot is only written through
         * the caller's Agent Storage transaction.
         */
        beforeAgentLoop: async (ctx: Context, scope: AgentModuleScope): Promise<void> => {
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
         * The dynamic tool list is intentionally rebuilt from the host's current connected
         * catalog. Happy Agent remains authoritative for connection lifetime and trust; the module never
         * caches a client or treats its own heap as a server record.
         */
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
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
                ...merged.tools,
                ...protocolTools,
            ];
        },
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;

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
        const raw = await this.#host.listServers(ctx, agentId, permissionMode, normalized);
        assertServerPage(raw);
        if (raw.servers.length > normalized.limit) {
            throw new Error("MCP host returned more servers than requested.");
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
        const raw = await this.#host.listTools(ctx, agentId, normalized);
        assertToolPage(raw);
        if (raw.tools.length > normalized.limit) {
            throw new Error("MCP host returned more tools than requested.");
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
        const raw = await this.#host.listResources(ctx, agentId, normalized);
        assertResourcePage(raw);
        if (raw.resources.length > normalized.limit) {
            throw new Error("MCP host returned more resources than requested.");
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
        const raw = await this.#host.listResourceTemplates(ctx, agentId, normalized);
        assertResourceTemplatePage(raw);
        if (raw.resourceTemplates.length > normalized.limit) {
            throw new Error("MCP host returned more resource templates than requested.");
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
        const raw = await this.#host.listPrompts(ctx, agentId, normalized);
        assertPromptPage(raw);
        if (raw.prompts.length > normalized.limit) {
            throw new Error("MCP host returned more prompts than requested.");
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
        const options = {
            onElicitation: async (request: McpElicitationRequest) =>
                await handleMcpElicitation(ctx, request, this.#userInput),
        };
        if (!Value.Check(mcpHostCallOptionsSchema, options)) {
            throw new Error("MCP host call options are invalid.");
        }
        const raw = await this.#host.callTool(ctx, agentId, structuredClone(input), options);
        if (!Value.Check(mcpToolResultSchema, raw)) {
            throw new Error("MCP host returned an invalid tool result.");
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
        const raw = await this.#host.readResource(ctx, agentId, structuredClone(input));
        if (!Value.Check(mcpReadResourceResultSchema, raw)) {
            throw new Error("MCP host returned an invalid resource result.");
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
        const raw = await this.#host.getPrompt(ctx, agentId, structuredClone(input));
        if (!Value.Check(mcpGetPromptResultSchema, raw)) {
            throw new Error("MCP host returned an invalid prompt result.");
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
        if (this.#host.getToolPolicy !== undefined) {
            const policy = await this.#host.getToolPolicy(ctx, agentId, serverName);
            if (!Value.Check(mcpToolPolicySchema, policy)) {
                throw new Error("MCP host returned an invalid tool policy.");
            }
            return structuredClone(policy);
        }
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
}

export function assertMcpModuleOptions(value: unknown): asserts value is McpModuleOptions {
    const checked = runtimeOptions(value as McpModuleOptions);
    if (!Value.Check(mcpModuleOptionsSchema, checked)) {
        throw new Error("MCP module options are invalid.");
    }
}

function runtimeOptions(options: McpModuleOptions): McpModuleOptions {
    if (options === null || typeof options !== "object") return options;
    const host = options.host;
    return {
        ...options,
        host:
            host === null || typeof host !== "object"
                ? host
                : {
                      ...host,
                      callTool: host.callTool,
                      getPrompt: host.getPrompt,
                      ...(host.getToolPolicy === undefined
                          ? {}
                          : { getToolPolicy: host.getToolPolicy }),
                      listPrompts: host.listPrompts,
                      listResourceTemplates: host.listResourceTemplates,
                      listResources: host.listResources,
                      listServers: host.listServers,
                      listTools: host.listTools,
                      readResource: host.readResource,
                  },
        ...(options.userInput === undefined
            ? {}
            : {
                  userInput: {
                      ...options.userInput,
                      request: options.userInput.request,
                  },
              }),
    } as McpModuleOptions;
}

function assertAgentId(agentId: string): string {
    if (!Value.Check(mcpAgentIdSchema, agentId)) {
        throw new Error("MCP agent identity is invalid.");
    }
    return agentId;
}

function assertUnique(values: readonly string[], kind: string): void {
    if (new Set(values).size !== values.length) {
        throw new Error(`MCP host returned duplicate ${kind} identities.`);
    }
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
        throw new Error("MCP host returned a non-advancing cursor.");
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
