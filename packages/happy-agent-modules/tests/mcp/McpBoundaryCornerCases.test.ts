import { createRootContext, type Context } from "@steve.kite/stdlib";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";

import {
    McpModule,
    assertMcpHost,
    createMcpProtocolTools,
    type McpHost,
    type McpPromptPage,
    type McpReadResourceResult,
    type McpResourcePage,
    type McpResourceTemplatePage,
    type McpServerPage,
    type McpToolPage,
    type McpToolResult,
    mcpCallToolInputSchema,
    mcpGetPromptResultSchema,
    mcpHttpServerConfigSchema,
    mcpPromptPageSchema,
    mcpReadResourceResultSchema,
    mcpResourcePageSchema,
    mcpResourceTemplatePageSchema,
    mcpServerPageSchema,
    mcpStdioServerConfigSchema,
    mcpToolPageSchema,
    mcpToolResultSchema,
} from "../../sources/mcp/index.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const ctx = createRootContext().named("mcp-boundary-corner-case-test");

function tool(name: string, inputSchema: Record<string, unknown> = { type: "object" }) {
    return {
        name,
        description: `Description for ${name}.`,
        inputSchema,
    };
}

function baseHost(overrides: Partial<McpHost> = {}): McpHost {
    return {
        callTool: async (): Promise<McpToolResult> => ({ content: [{ type: "text", text: "ok" }] }),
        getPrompt: async () => ({ messages: [] }),
        listPrompts: async () => ({ prompts: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        listResources: async () => ({ resources: [] }),
        listServers: async () => ({
            servers: [{ name: "docs", status: "connected", toolCount: 1 }],
        }),
        listTools: async () => ({ tools: [tool("publish")] }),
        readResource: async (_ctx, _agentId, input) => ({
            contents: [{ uri: input.uri, text: "resource" }],
        }),
        ...overrides,
    } as McpHost;
}

describe("MCP host and module boundaries", () => {
    it("rejects malformed host implementations before any operation runs", () => {
        expect(() => assertMcpHost(undefined)).toThrow("invalid host");
        expect(() => assertMcpHost({})).toThrow("invalid host");
        expect(
            () =>
                new McpModule({
                    host: {
                        ...baseHost(),
                        listTools: "not a function",
                    } as never,
                }),
        ).toThrow("options are invalid");
    });

    it("rejects invalid module bounds", () => {
        expect(
            () =>
                new McpModule({
                    host: baseHost(),
                    maxPageSize: 0,
                } as never),
        ).toThrow("options are invalid");
        expect(
            () =>
                new McpModule({
                    host: baseHost(),
                    maxOutputCharacters: 255,
                } as never),
        ).toThrow("options are invalid");
        expect(
            () =>
                new McpModule({
                    host: baseHost(),
                    maxOutputCharacters: 100_001,
                } as never),
        ).toThrow("options are invalid");
    });

    it("validates the public TypeBox host-facing schemas", () => {
        expect(
            Value.Check(mcpCallToolInputSchema, {
                arguments: { nested: ["json", 1, true, null] },
                name: "publish",
                server: "docs",
            }),
        ).toBe(true);
        expect(
            Value.Check(mcpCallToolInputSchema, {
                arguments: { nested: { tooDeep: { still: { okay: true } } } },
                name: "publish",
                server: "docs",
            }),
        ).toBe(true);
        expect(
            Value.Check(mcpCallToolInputSchema, {
                arguments: { bad: BigInt(1) },
                name: "publish",
                server: "docs",
            }),
        ).toBe(false);
        expect(
            Value.Check(mcpCallToolInputSchema, {
                arguments: { bad: { unsupported: undefined } },
                name: "publish",
                server: "docs",
            }),
        ).toBe(false);
        expect(
            Value.Check(mcpCallToolInputSchema, {
                arguments: { bad: "x" },
                name: "publish",
                server: "docs",
                extra: true,
            }),
        ).toBe(false);
        expect(
            Value.Check(mcpToolResultSchema, {
                content: [{ type: "text", text: "ok", _meta: { source: "server" } }],
            }),
        ).toBe(true);
        expect(
            Value.Check(mcpToolResultSchema, {
                content: [{ type: "text", text: "ok", unknown: true }],
            }),
        ).toBe(false);
        expect(Value.Check(mcpReadResourceResultSchema, { contents: [] })).toBe(true);
        expect(
            Value.Check(mcpReadResourceResultSchema, {
                contents: [{ uri: "docs://one", text: "x", extra: true }],
            }),
        ).toBe(false);
        expect(
            Value.Check(mcpGetPromptResultSchema, {
                messages: [{ role: "user", content: { type: "text", text: "hello" } }],
            }),
        ).toBe(true);
        expect(
            Value.Check(mcpGetPromptResultSchema, {
                messages: [{ role: "system", content: { type: "text", text: "hello" } }],
            }),
        ).toBe(false);
        expect(
            Value.Check(mcpStdioServerConfigSchema, {
                command: "server",
                transport: "stdio",
            }),
        ).toBe(true);
        expect(
            Value.Check(mcpHttpServerConfigSchema, {
                transport: "http",
                url: "https://example.test/mcp",
            }),
        ).toBe(true);
        expect(
            Value.Check(mcpHttpServerConfigSchema, {
                transport: "http",
                url: "https://example.test/mcp",
                command: "must-not-be-here",
            }),
        ).toBe(false);
    });
});

describe("MCP page validation and cursor safety", () => {
    it("forwards bounded server queries and preserves the caller cursor", async () => {
        const listServers = vi.fn(
            async (): Promise<McpServerPage> => ({
                nextCursor: "next",
                servers: [{ name: "docs", status: "connected", toolCount: 1 }],
            }),
        );
        const module = new McpModule({ host: baseHost({ listServers }), maxPageSize: 7 });

        const page = await module.listServerPage(
            ctx,
            "agent",
            { cursor: "old", limit: 3 },
            "full_access",
        );

        expect(page).toEqual({
            nextCursor: "next",
            servers: [{ name: "docs", status: "connected", toolCount: 1 }],
        });
        expect(listServers).toHaveBeenCalledWith(ctx, "agent", "full_access", {
            cursor: "old",
            limit: 3,
        });
    });

    it("rejects invalid identities, duplicate records, empty-page cursors, and repeated cursors", async () => {
        const module = new McpModule({
            host: baseHost({
                listServers: async () => ({
                    nextCursor: "same",
                    servers: [{ name: "docs", status: "connected", toolCount: 0 }],
                }),
            }),
        });
        await expect(module.listServerPage(ctx, "agent", { cursor: "same" })).rejects.toThrow(
            "non-advancing cursor",
        );
        await expect(
            new McpModule({
                host: baseHost({
                    listServers: async () => ({ nextCursor: "next", servers: [] }),
                }),
            }).listServerPage(ctx, "agent"),
        ).rejects.toThrow("non-advancing cursor");
        await expect(
            new McpModule({
                host: baseHost({
                    listServers: async () => ({
                        servers: [
                            { name: "docs", status: "connected", toolCount: 0 },
                            { name: "docs", status: "disabled", toolCount: 0 },
                        ],
                    }),
                }),
            }).listServerPage(ctx, "agent"),
        ).rejects.toThrow("duplicate server identities");
        await expect(module.listServerPage(ctx, "")).rejects.toThrow("identity is invalid");
        await expect(module.listServerPage(ctx, "agent\ninjection")).rejects.toThrow(
            "identity is invalid",
        );
    });

    it.each([
        [
            "tools",
            "listToolPage",
            "listTools",
            { tools: [{ name: "one", inputSchema: { type: "object" } }] },
            "tools",
            "duplicate tool identities",
        ],
        [
            "resources",
            "listResourcePage",
            "listResources",
            { resources: [{ name: "one", uri: "docs://one" }] },
            "resources",
            "duplicate resource identities",
        ],
        [
            "templates",
            "listResourceTemplatePage",
            "listResourceTemplates",
            { resourceTemplates: [{ name: "one", uriTemplate: "docs://{id}" }] },
            "resourceTemplates",
            "duplicate resource template identities",
        ],
        [
            "prompts",
            "listPromptPage",
            "listPrompts",
            { prompts: [{ name: "one" }] },
            "prompts",
            "duplicate prompt identities",
        ],
    ] as const)(
        "rejects duplicate %s identities",
        async (_kind, method, hostMethod, page, key, message) => {
            const duplicate = {
                [key]: [
                    (page as unknown as Record<string, readonly unknown[]>)[key]![0],
                    (page as unknown as Record<string, readonly unknown[]>)[key]![0],
                ],
            } as never;
            const hostOverrides = { [hostMethod]: async () => duplicate } as Partial<McpHost>;
            const module = new McpModule({ host: baseHost(hostOverrides) });
            const invoke = (
                module as unknown as Record<
                    string,
                    (ctx: Context, agentId: string, query: unknown) => Promise<unknown>
                >
            )[method]!.bind(module);
            await expect(invoke(ctx, "agent", { server: "docs" })).rejects.toThrow(message);
        },
    );

    it("rejects host pages that exceed the requested limit or contain unknown fields", async () => {
        const module = new McpModule({
            host: baseHost({
                listTools: async () => ({
                    tools: [tool("one"), tool("two")],
                }),
            }),
            maxPageSize: 1,
        });
        await expect(module.listToolPage(ctx, "agent", { server: "docs" })).rejects.toThrow(
            "more tools than requested",
        );

        const invalid = new McpModule({
            host: baseHost({
                listResources: async () => ({
                    resources: [{ name: "one", uri: "docs://one", extra: "host lie" }],
                }),
            }),
        });
        await expect(invalid.listResourcePage(ctx, "agent", { server: "docs" })).rejects.toThrow(
            "invalid resource page",
        );
    });

    it("deep-clones host pages before returning them", async () => {
        const raw: McpToolPage = {
            tools: [tool("publish")],
        };
        const module = new McpModule({
            host: baseHost({
                listTools: async () => raw,
            }),
        });
        const page = await module.listToolPage(ctx, "agent", { server: "docs" });
        page.tools[0]!.name = "mutated";
        expect(raw.tools[0]!.name).toBe("publish");
    });

    it("uses each list overload and forwards cursors for resources and tools", async () => {
        const listTools = vi.fn(
            async (_ctx: Context, _agentId: string, query: { cursor?: string }) => ({
                tools: [tool(query.cursor === "next" ? "second" : "first")],
            }),
        );
        const listResources = vi.fn(
            async (_ctx: Context, _agentId: string, query: { cursor?: string }) => ({
                resources: [{ name: "one", uri: `docs://${query.cursor ?? "first"}` }],
            }),
        );
        const module = new McpModule({ host: baseHost({ listTools, listResources }) });

        expect(await module.listTools(ctx, "agent", "docs", "next")).toEqual([
            {
                name: "second",
                description: "Description for second.",
                inputSchema: { type: "object" },
            },
        ]);
        expect(await module.listResources(ctx, "agent", "docs", "next")).toEqual([
            { name: "one", uri: "docs://next" },
        ]);
        expect(listTools).toHaveBeenCalledWith(ctx, "agent", {
            server: "docs",
            cursor: "next",
            limit: 50,
        });
        expect(listResources).toHaveBeenCalledWith(ctx, "agent", {
            server: "docs",
            cursor: "next",
            limit: 50,
        });
    });
});

describe("MCP dynamic tools and protocol tools", () => {
    it("loads only connected object-rooted tools and exposes no protocol tools when none connect", async () => {
        const module = new McpModule({
            host: baseHost({
                listServers: async () => ({
                    servers: [
                        { name: "disabled", status: "disabled", toolCount: 1 },
                        { name: "docs", status: "connected", toolCount: 2 },
                    ],
                }),
                listTools: async () => ({
                    tools: [tool("valid"), tool("non_object", { type: "string" })],
                }),
            }),
        });
        const hooks = await resolveModuleHooks(ctx, module);
        const tools = await hooks.tools!(ctx, {
            agent: { id: "agent", permissionMode: "auto" },
        } as never);
        expect(tools.map((candidate) => candidate.name)).toEqual([
            "list_mcp_servers",
            "mcp__docs__valid",
            "list_mcp_tools",
            "call_mcp_tool",
            "list_mcp_resources",
            "list_mcp_resource_templates",
            "read_mcp_resource",
            "list_mcp_prompts",
            "get_mcp_prompt",
        ]);

        const noConnected = new McpModule({
            host: baseHost({
                listServers: async () => ({
                    servers: [{ name: "disabled", status: "disabled", toolCount: 0 }],
                }),
            }),
        });
        const noConnectedTools = await (
            await resolveModuleHooks(ctx, noConnected)
        ).tools!(ctx, {
            agent: { id: "agent", permissionMode: "auto" },
        } as never);
        expect(noConnectedTools.map((candidate) => candidate.name)).toEqual(["list_mcp_servers"]);
    });

    it("exposes honest review declarations for every protocol surface", async () => {
        const module = new McpModule({ host: baseHost() });
        const protocol = createMcpProtocolTools(module, "agent", [{ name: "docs" }]);
        const byName = new Map(protocol.map((candidate) => [candidate.name, candidate]));
        expect(await byName.get("list_mcp_tools")?.shouldReviewInAutoMode?.({}, ctx)).toBe(false);
        expect(await byName.get("list_mcp_resources")?.shouldReviewInAutoMode?.({}, ctx)).toBe(
            false,
        );
        expect(
            await byName.get("list_mcp_resource_templates")?.shouldReviewInAutoMode?.({}, ctx),
        ).toBe(false);
        expect(await byName.get("read_mcp_resource")?.shouldReviewInAutoMode?.({}, ctx)).toBe(
            false,
        );
        expect(await byName.get("list_mcp_prompts")?.shouldReviewInAutoMode?.({}, ctx)).toBe(false);
        expect(await byName.get("call_mcp_tool")?.shouldReviewInAutoMode?.({}, ctx)).toBe(true);
        expect(await byName.get("get_mcp_prompt")?.shouldReviewInAutoMode?.({}, ctx)).toBe(true);
        expect(byName.get("call_mcp_tool")?.requiresAutoOrFullAccess).toBe(true);
        expect(byName.get("get_mcp_prompt")?.requiresAutoOrFullAccess).toBe(true);
        expect(
            byName.get("get_mcp_prompt")?.describeAutoPermissionAction?.(
                {
                    name: "deploy",
                    server: "docs",
                } as never,
                ctx,
            ),
        ).toContain("outside Happy Agent");
    });

    it("rejects unknown protocol servers before dispatch", async () => {
        const listTools = vi.fn(async () => ({ tools: [tool("valid")] }));
        const module = new McpModule({ host: baseHost({ listTools }) });
        const protocol = createMcpProtocolTools(module, "agent", [{ name: "docs" }]);
        const list = protocol.find((candidate) => candidate.name === "list_mcp_tools");
        await expect(list?.execute(ctx, { server: "evil" }, undefined as never)).rejects.toThrow(
            'Unknown MCP server "evil"',
        );
        expect(listTools).not.toHaveBeenCalled();
    });

    it("routes protocol resource, prompt, and call operations through the host", async () => {
        const listResources = vi.fn(async () => ({
            resources: [{ name: "one", uri: "docs://one" }],
        }));
        const listResourceTemplates = vi.fn(async () => ({
            resourceTemplates: [{ name: "template", uriTemplate: "docs://{id}" }],
        }));
        const listPrompts = vi.fn(async () => ({ prompts: [{ name: "deploy" }] }));
        const getPrompt = vi.fn(async () => ({
            messages: [{ role: "user" as const, content: { type: "text" as const, text: "run" } }],
        }));
        const callTool = vi.fn(async () => ({
            content: [{ type: "text" as const, text: "called" }],
        }));
        const module = new McpModule({
            host: baseHost({
                listResources,
                listResourceTemplates,
                listPrompts,
                getPrompt,
                callTool,
            }),
        });
        const protocol = createMcpProtocolTools(module, "agent", [{ name: "docs" }]);
        const execute = async (name: string, input: unknown) =>
            await protocol
                .find((candidate) => candidate.name === name)!
                .execute(ctx, input, undefined as never);
        await execute("list_mcp_resources", { server: "docs" });
        await execute("list_mcp_resource_templates", { server: "docs" });
        await execute("list_mcp_prompts", { server: "docs" });
        await execute("read_mcp_resource", { server: "docs", uri: "docs://one" });
        await execute("get_mcp_prompt", { server: "docs", name: "deploy" });
        await execute("call_mcp_tool", { server: "docs", name: "publish", arguments: {} });
        expect(listResources).toHaveBeenCalledWith(ctx, "agent", { server: "docs", limit: 50 });
        expect(listResourceTemplates).toHaveBeenCalledWith(ctx, "agent", {
            server: "docs",
            limit: 50,
        });
        expect(listPrompts).toHaveBeenCalledWith(ctx, "agent", { server: "docs", limit: 50 });
        expect(getPrompt).toHaveBeenCalledWith(ctx, "agent", {
            server: "docs",
            name: "deploy",
        });
        expect(callTool).toHaveBeenCalledWith(
            ctx,
            "agent",
            { server: "docs", name: "publish", arguments: {} },
            expect.objectContaining({ onElicitation: expect.any(Function) }),
        );
    });
});

describe("MCP operations and host failures", () => {
    it("rejects malformed call/read/prompt inputs without dispatching", async () => {
        const callTool = vi.fn(async () => ({ content: [] }));
        const readResource = vi.fn(async () => ({ contents: [] }));
        const getPrompt = vi.fn(async () => ({ messages: [] }));
        const module = new McpModule({ host: baseHost({ callTool, readResource, getPrompt }) });

        await expect(
            module.callTool(ctx, "agent", {
                server: "docs",
                name: "",
                arguments: {},
            } as never),
        ).rejects.toThrow("call input is invalid");
        await expect(module.callTool(ctx, "agent", "docs", undefined)).rejects.toThrow(
            "call input is invalid",
        );
        await expect(
            module.readResource(ctx, "agent", { server: "docs", uri: "" } as never),
        ).rejects.toThrow("read input is invalid");
        await expect(
            module.getPrompt(ctx, "agent", { server: "docs", name: "", arguments: {} } as never),
        ).rejects.toThrow("prompt input is invalid");
        expect(callTool).not.toHaveBeenCalled();
        expect(readResource).not.toHaveBeenCalled();
        expect(getPrompt).not.toHaveBeenCalled();
    });

    it("forwards overload arguments and deep-clones both inputs and outputs", async () => {
        const callResult: McpToolResult = { content: [{ type: "text", text: "ok" }] };
        let receivedCallInput: unknown;
        const callTool = vi.fn(async (_ctx, _agent, input) => {
            receivedCallInput = structuredClone(input);
            input.arguments!.nested = "host mutation";
            return callResult;
        });
        const readResult: McpReadResourceResult = {
            contents: [{ uri: "docs://one", text: "ok" }],
        };
        let receivedReadInput: unknown;
        const readResource = vi.fn(async (_ctx, _agent, input) => {
            receivedReadInput = structuredClone(input);
            input.uri = "host mutation";
            return readResult;
        });
        const module = new McpModule({ host: baseHost({ callTool, readResource }) });
        const args = { nested: "caller" };
        const result = await module.callTool(ctx, "agent", "docs", "publish", args);
        const resource = await module.readResource(ctx, "agent", "docs", "docs://one");
        expect(receivedCallInput).toEqual({
            server: "docs",
            name: "publish",
            arguments: args,
        });
        expect(callTool).toHaveBeenCalledWith(ctx, "agent", expect.anything(), expect.anything());
        expect(args).toEqual({ nested: "caller" });
        expect(result).not.toBe(callResult);
        expect(receivedReadInput).toEqual({ server: "docs", uri: "docs://one" });
        expect(readResource).toHaveBeenCalledWith(ctx, "agent", expect.anything());
        expect(resource).not.toBe(readResult);
        expect(resource.contents[0]!.uri).toBe("docs://one");
    });

    it("rejects invalid host results, host URI confusion, and invalid policies", async () => {
        const module = new McpModule({
            host: baseHost({
                callTool: async () => ({ content: [{ type: "text", text: "ok", extra: true }] }),
                readResource: async () => ({
                    contents: [{ uri: "docs://other", text: "not requested" }],
                }),
            }),
        });
        await expect(
            module.callTool(ctx, "agent", { server: "docs", name: "publish", arguments: {} }),
        ).rejects.toThrow("invalid tool result");
        await expect(
            module.readResource(ctx, "agent", { server: "docs", uri: "docs://one" }),
        ).rejects.toThrow("different URI");

        const invalidPolicy = new McpModule({
            host: baseHost({
                getToolPolicy: async () => ({ disabledTools: ["publish"], unexpected: true }),
            }),
        });
        await expect(
            invalidPolicy.callTool(ctx, "agent", {
                server: "docs",
                name: "publish",
                arguments: {},
            }),
        ).rejects.toThrow("invalid tool policy");
    });

    it("falls back to server policy lists and gives disabled precedence", async () => {
        const callTool = vi.fn(
            async (): Promise<McpToolResult> => ({ content: [{ type: "text", text: "ok" }] }),
        );
        const module = new McpModule({
            host: baseHost({
                callTool,
                listServers: async () => ({
                    servers: [
                        {
                            name: "docs",
                            status: "connected",
                            toolCount: 1,
                            enabledTools: ["publish", "delete"],
                            disabledTools: ["publish"],
                        },
                    ],
                }),
            }),
        });
        await expect(
            module.callTool(ctx, "agent", { server: "docs", name: "publish", arguments: {} }),
        ).rejects.toThrow("disabled by the server policy");
        await expect(
            module.callTool(ctx, "agent", { server: "docs", name: "other", arguments: {} }),
        ).rejects.toThrow("disabled by the server policy");
        await expect(
            module.callTool(ctx, "agent", { server: "docs", name: "delete", arguments: {} }),
        ).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
        expect(callTool).toHaveBeenCalledTimes(1);
    });
});

describe("MCP model formatters", () => {
    it("render every catalog identity, empty pages, and continuation cursors", () => {
        const module = new McpModule({ host: baseHost() });
        expect(module.formatServerPageForModel({ servers: [] })).toBe("No MCP servers.");
        expect(module.formatToolPageForModel({ tools: [] })).toBe("No MCP tools.");
        expect(module.formatResourcePageForModel({ resources: [] })).toBe("No MCP resources.");
        expect(module.formatResourceTemplatePageForModel({ resourceTemplates: [] })).toBe(
            "No MCP resource templates.",
        );
        expect(module.formatPromptPageForModel({ prompts: [] })).toBe("No MCP prompts.");
        expect(
            module.formatServerPageForModel({
                nextCursor: "cursor",
                servers: [{ name: "docs", status: "connected", toolCount: 2 }],
            }),
        ).toBe("docs\tconnected\t2 tools\nMore results at cursor cursor.");
        expect(
            module.formatResourcePageForModel({
                resources: [{ name: "Resource", uri: "docs://one" }],
            }),
        ).toBe("docs://one — Resource");
    });

    it("rejects a formatter budget that cannot fit an identity or continuation", () => {
        const module = new McpModule({ host: baseHost(), maxOutputCharacters: 256 });
        expect(() =>
            module.formatToolPageForModel({
                tools: [
                    {
                        name: "x".repeat(128),
                        description: "d".repeat(16_000),
                        inputSchema: { type: "object" },
                    },
                ],
            } as never),
        ).not.toThrow();
        expect(() =>
            module.formatToolPageForModel({
                nextCursor: "c".repeat(32),
                tools: [{ name: "x".repeat(128), inputSchema: { type: "object" } }],
            } as never),
        ).not.toThrow();
        expect(() =>
            new McpModule({ host: baseHost(), maxOutputCharacters: 256 }).formatToolPageForModel({
                nextCursor: "c".repeat(32),
                tools: [{ name: "x".repeat(128), inputSchema: { type: "object" } }],
            } as never),
        ).not.toThrow();
    });
});
