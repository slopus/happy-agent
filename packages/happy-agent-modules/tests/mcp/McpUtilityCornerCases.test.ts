import { createRootContext } from "@steve.kite/stdlib";
import { Value } from "@sinclair/typebox/value";
import { defineAgentTool, type AnyAgentTool } from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";

import {
    MAX_MCP_ERROR_MESSAGE_LENGTH,
    McpModule,
    MCP_TRUST_ANSWER,
    createMcpProtocolTools,
    createMcpTrustUserInputRequest,
    createProjectMcpSecurityNotice,
    describeMcpAutoPermissionAction,
    fingerprintMcpServer,
    humanizeMcpName,
    mergeMcpTools,
    normalizeMcpName,
    type McpHost,
    type McpServerConfigEntry,
    type McpToolResult,
} from "../../sources/mcp/index.js";
import {
    mcpAgentIdSchema,
    mcpJsonValueSchema,
    mcpServerConfigEntryListSchema,
    mcpServerConfigSchema,
    mcpServerNameSchema,
    mcpToolNameSchema,
    mcpUriSchema,
} from "../../sources/mcp/Mcp.js";
import { listMcpServersTool } from "../../sources/mcp/tools/list_mcp_servers.js";
import { quoteVisibleExact } from "../../sources/impl/quoteVisibleExact.js";

const ctx = createRootContext().named("mcp-utility-corner-case-test");

function host(overrides: Partial<McpHost> = {}): McpHost {
    return {
        callTool: async (): Promise<McpToolResult> => ({ content: [] }),
        getPrompt: async () => ({ messages: [] }),
        listPrompts: async () => ({ prompts: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        listResources: async () => ({ resources: [] }),
        listServers: async () => ({ servers: [] }),
        listTools: async () => ({ tools: [] }),
        readResource: async () => ({ contents: [] }),
        ...overrides,
    } as McpHost;
}

function fakeTool(name: string): AnyAgentTool {
    return defineAgentTool({
        name,
        description: name,
        parameters: {},
        returnType: {},
        execute: async () => ({ ok: true }),
    } as never);
}

function configuredEntry(
    source: McpServerConfigEntry["source"] = "global",
    overrides: Partial<McpServerConfigEntry> = {},
): McpServerConfigEntry {
    return {
        config: {
            command: "docs-server",
            transport: "stdio",
        },
        name: "docs",
        source,
        ...overrides,
    };
}

describe("MCP names and security-facing descriptions", () => {
    it("normalizes arbitrary names and humanizes edge-case display names", () => {
        expect(normalizeMcpName("a/b c:d@e")).toBe("a_b_c_d_e");
        expect(normalizeMcpName("")).toBe("");
        expect(humanizeMcpName("")).toBe("MCP");
        expect(humanizeMcpName("", "Server")).toBe("Server");
        expect(humanizeMcpName("openaiDeveloper_docs")).toBe("OpenAI Developer Docs");
        expect(humanizeMcpName("post_hog_api")).toBe("PostHog Api");
        expect(humanizeMcpName("foo--BAR")).toBe("Foo Bar");
    });

    it("makes terminal, bidi, quote, and backslash characters visible", () => {
        expect(quoteVisibleExact('a"b\\c\n\r\t')).toBe('"a\\"b\\\\c\\n\\r\\t"');
        expect(quoteVisibleExact("\u0000\u001f\u007f\u202e\u2066")).toBe(
            '"\\u{0000}\\u{001f}\\u{007f}\\u{202e}\\u{2066}"',
        );
        const description = describeMcpAutoPermissionAction({
            arguments: { message: "\u202e\n" },
            server: "docs/server",
            tool: "delete-release",
        });
        expect(description).toContain('"Delete Release"');
        expect(description).toContain('"Docs/Server"');
        expect(description).toContain("\\u{202e}");
        expect(description).toContain("outside Happy Agent");
    });

    it("survives circular arguments while describing a permission action", () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        expect(
            describeMcpAutoPermissionAction({
                arguments: circular,
                server: "docs",
                tool: "run",
            }),
        ).toContain("[object Object]");
    });
});

describe("MCP trust records and project notices", () => {
    it("fingerprints durable configuration, including project workspace scope only for projects", () => {
        const global = configuredEntry("global");
        const project = configuredEntry("project");
        expect(fingerprintMcpServer(global, "/one")).toBe(fingerprintMcpServer(global, "/two"));
        expect(fingerprintMcpServer(project, "/one")).not.toBe(
            fingerprintMcpServer(project, "/two"),
        );
        expect(fingerprintMcpServer(global)).not.toBe(
            fingerprintMcpServer(configuredEntry("runtime")),
        );
        expect(fingerprintMcpServer(global)).not.toBe(
            fingerprintMcpServer(
                configuredEntry("global", {
                    config: { command: "other", transport: "stdio" },
                }),
            ),
        );
    });

    it("renders bounded trust prompts for stdio, HTTP, environment, and source variants", () => {
        const stdio = configuredEntry("project", {
            config: {
                args: ["--stdio", "quoted arg"],
                command: "docs-server",
                cwd: "/configured",
                env: { ZED: "secret", API: "secret" },
                transport: "stdio",
            },
        });
        const trust = createMcpTrustUserInputRequest({
            ...stdio,
            effectiveCwd: "/effective",
            fingerprint: fingerprintMcpServer(stdio, "/workspace"),
        });
        expect(trust.questions[0]).toMatchObject({
            id: "mcp_trust",
            options: [{ label: MCP_TRUST_ANSWER }, { label: "Don't trust" }],
        });
        expect(trust.questions[0]?.question).toContain("this project's configuration");
        expect(trust.questions[0]?.options[0]?.description).toContain(
            'Run "docs-server" with arguments "--stdio" "quoted arg" from "/effective".',
        );
        expect(trust.questions[0]?.options[0]?.description).toContain(
            "environment values for API, ZED.",
        );

        const http = configuredEntry("runtime", {
            config: {
                bearerTokenEnvVar: "MCP_TOKEN",
                headers: { Authorization: "secret" },
                transport: "http",
                url: "https://example.test/mcp",
            },
        });
        const httpTrust = createMcpTrustUserInputRequest({
            ...http,
            fingerprint: fingerprintMcpServer(http),
        });
        expect(httpTrust.questions[0]?.question).toContain("your saved Happy Agent preferences");
        expect(httpTrust.questions[0]?.options[0]?.description).toContain(
            'Connect to "https://example.test/mcp".',
        );
        expect(httpTrust.questions[0]?.options[0]?.description).not.toContain("MCP_TOKEN");
    });

    it("bounds untrusted trust text and describes project shadowing", () => {
        const entry = configuredEntry("project", {
            config: {
                args: ["x".repeat(4_096)],
                command: "server",
                transport: "stdio",
            },
        });
        const prompt = createMcpTrustUserInputRequest({
            ...entry,
            fingerprint: fingerprintMcpServer(entry, "/workspace"),
        });
        const description = prompt.questions[0]?.options[0]?.description ?? "";
        expect(description.length).toBeLessThan(4_200);
        expect(description).toContain("… [truncated]");
        expect(createProjectMcpSecurityNotice([])).toBeUndefined();
        expect(createProjectMcpSecurityNotice([entry])).toContain("one-time trust");
        expect(
            createProjectMcpSecurityNotice([configuredEntry("global", { projectShadowed: true })]),
        ).toContain("takes precedence");
        expect(
            createProjectMcpSecurityNotice([
                entry,
                configuredEntry("global", { projectShadowed: true }),
            ]),
        ).toContain("one-time trust");
    });
});

describe("MCP tool merge and protocol validation", () => {
    it("quarantines only servers contributing collisions and keeps healthy tools", () => {
        const result = mergeMcpTools([fakeTool("existing")], {
            servers: [
                { name: "broken", status: "connected", toolCount: 2 },
                { name: "healthy", status: "connected", toolCount: 1 },
            ],
            tools: [
                fakeTool("mcp__broken__one"),
                fakeTool("mcp__broken__one"),
                fakeTool("mcp__healthy__okay"),
                fakeTool("existing"),
            ],
        });
        expect(result.tools.map((tool) => tool.name)).toEqual(["existing", "mcp__healthy__okay"]);
        expect(result.servers).toEqual([
            expect.objectContaining({
                name: "broken",
                status: "failed",
                toolCount: 0,
                errorMessage: expect.stringContaining("collision"),
            }),
            expect.objectContaining({ name: "healthy", status: "connected" }),
            expect.objectContaining({ name: "MCP tools", status: "failed", toolCount: 0 }),
        ]);
    });

    it("reports an unqualified collision through a synthetic quarantined server", () => {
        const result = mergeMcpTools([fakeTool("not-qualified")], {
            servers: [{ name: "healthy", status: "connected", toolCount: 0 }],
            tools: [fakeTool("not-qualified")],
        });
        expect(result.tools.map((tool) => tool.name)).toEqual(["not-qualified"]);
        expect(result.servers.at(-1)).toMatchObject({
            name: "MCP tools",
            status: "failed",
            toolCount: 0,
        });
    });

    it("bounds collision diagnostics", () => {
        const result = mergeMcpTools([], {
            servers: [{ name: "docs", status: "connected", toolCount: 100 }],
            tools: Array.from({ length: 100 }, (_, index) =>
                fakeTool(`mcp__docs__${String(index).padStart(3, "0")}`),
            ),
        });
        expect(result.servers[0]?.errorMessage).toBeUndefined();
        const colliding = mergeMcpTools(
            Array.from({ length: 100 }, (_, index) => fakeTool(`mcp__docs__${String(index)}`)),
            {
                servers: [{ name: "docs", status: "connected", toolCount: 100 }],
                tools: Array.from({ length: 100 }, (_, index) =>
                    fakeTool(`mcp__docs__${String(index)}`),
                ),
            },
        );
        expect(colliding.servers[0]?.errorMessage?.length).toBeLessThanOrEqual(
            MAX_MCP_ERROR_MESSAGE_LENGTH,
        );
    });

    it("rejects duplicate and invalid connected server lists before creating tools", () => {
        const module = new McpModule({ host: host() });
        expect(() =>
            createMcpProtocolTools(module, "agent", [{ name: "docs" }, { name: "docs" }]),
        ).toThrow("duplicate names");
        expect(() => createMcpProtocolTools(module, "", [])).toThrow("connected server list");
        expect(() => createMcpProtocolTools(module, "agent", [{ name: "" }])).toThrow(
            "connected server list",
        );
    });

    it("overlays quarantined server snapshots in the list tool without mutating host pages", async () => {
        const module = new McpModule({
            host: host({
                listServers: async () => ({
                    servers: [{ name: "broken", status: "connected", toolCount: 2 }],
                }),
            }),
        });
        const tool = listMcpServersTool(module, "agent", "auto", [
            {
                name: "broken",
                status: "failed",
                toolCount: 0,
                errorMessage: "collision",
            },
        ]);
        const page = (await tool.execute(ctx, {}, undefined as never)) as {
            servers: Array<{ status: string; toolCount: number }>;
        };
        expect(page.servers[0]).toMatchObject({ status: "failed", toolCount: 0 });
    });
});

describe("MCP schema bounds", () => {
    it("enforces identity limits, finite JSON, and valid transport discriminants", () => {
        expect(Value.Check(mcpAgentIdSchema, "a".repeat(256))).toBe(true);
        expect(Value.Check(mcpAgentIdSchema, "a".repeat(257))).toBe(false);
        expect(Value.Check(mcpAgentIdSchema, "agent\nid")).toBe(false);
        expect(Value.Check(mcpServerNameSchema, "")).toBe(false);
        expect(Value.Check(mcpToolNameSchema, "a".repeat(129))).toBe(false);
        expect(Value.Check(mcpUriSchema, "u".repeat(129))).toBe(false);
        expect(Value.Check(mcpJsonValueSchema, { value: [1, true, null, "x"] })).toBe(true);
        expect(Value.Check(mcpJsonValueSchema, BigInt(1))).toBe(false);
        expect(Value.Check(mcpServerConfigSchema, { transport: "tcp", url: "x" })).toBe(false);
        expect(Value.Check(mcpServerConfigEntryListSchema, [configuredEntry()])).toBe(true);
    });
});
