import type { Options as ClaudeSdkOptions } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { SessionContext } from "@/core/SessionContext.js";
import type { SessionReasoningEffort, SessionStructuredOutput } from "@/core/SessionRunRequest.js";
import type { SessionTool } from "@/core/SessionTool.js";
import { toLlmParametersSchema } from "@/tools/sanitizeSchema.js";
import { DEFAULT_INFERENCE_MAX_RETRIES } from "@/core/inferenceRetrySettings.js";
import type { ClaudeCredential } from "@/vendors/VendorCredential.js";
import { CLAUDE_SDK_PRIVACY_ENVIRONMENT } from "@/vendors/claude/claudeSdkPrivacyEnvironment.js";

const RIG_MCP_SERVER_NAME = "rig";

export function toClaudeSdkOptions(options: {
    abort?: AbortSignal;
    context: SessionContext;
    credential: ClaudeCredential;
    effort?: SessionReasoningEffort;
    env: NodeJS.ProcessEnv;
    model: string;
    maxRetries?: number;
    pathToClaudeCodeExecutable?: string;
    sessionId: string;
    structuredOutput?: SessionStructuredOutput;
    systemPrompt: string;
    tools: readonly SessionTool[];
    userAgent?: string;
    compaction?: boolean;
    callTool?: (toolUseId: string) => Promise<CallToolResult>;
    registerAbortCleanup?: (cleanup: () => void) => void;
}): ClaudeSdkOptions {
    const clientTools = options.tools.filter((tool) => tool.server === undefined);
    const mcpToolNames = clientTools.map((tool) => `mcp__${RIG_MCP_SERVER_NAME}__${tool.name}`);
    const toolSearchEnabled = hasClaudeToolSearch(options.tools);
    const builtInToolNames = claudeSdkBuiltInToolNames(options.tools);
    const { abortController, cleanup } = toAbortController(options.abort);
    options.registerAbortCleanup?.(cleanup);
    return {
        allowedTools: [...mcpToolNames, ...builtInToolNames],
        mcpServers: {
            [RIG_MCP_SERVER_NAME]: createClaudeMcpServer(
                clientTools,
                options.callTool,
                toolSearchEnabled,
            ),
        },
        ...(options.compaction ? { maxTurns: 1 } : {}),
        model: options.model,
        ...(options.pathToClaudeCodeExecutable === undefined
            ? {}
            : { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable }),
        env: {
            ...withoutClaudeCredentials(options.env),
            ...credentialEnvironment(options.credential),
            ...CLAUDE_SDK_PRIVACY_ENVIRONMENT,
            ...customHeaders(options.env, options.userAgent),
            CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
            CLAUDE_AGENT_SDK_MCP_NO_PREFIX: "1",
            CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
            CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
            CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
            CLAUDE_CODE_MAX_RETRIES: String(options.maxRetries ?? DEFAULT_INFERENCE_MAX_RETRIES),
            // Match Claude Code's normal one-hour prompt-cache lifetime deterministically.
            ENABLE_PROMPT_CACHING_1H: "1",
            ...(toolSearchEnabled ? { ENABLE_TOOL_SEARCH: "true" } : {}),
        },
        extraArgs: options.compaction ? {} : { "disable-slash-commands": null },
        includePartialMessages: true,
        permissionMode: "dontAsk",
        persistSession: false,
        ...(options.structuredOutput === undefined
            ? {}
            : {
                  outputFormat: {
                      type: "json_schema" as const,
                      schema: options.structuredOutput.schema,
                  },
              }),
        sessionId: options.sessionId,
        settingSources: [],
        settings: { env: CLAUDE_SDK_PRIVACY_ENVIRONMENT },
        skills: [],
        strictMcpConfig: true,
        systemPrompt: createSystemPrompt(options.systemPrompt, options.context),
        // An empty list disables every built-in. A server tool is named here instead of being
        // bridged over MCP, which is what hands the call to Claude Code's own implementation.
        tools: builtInToolNames,
        ...(abortController === undefined ? {} : { abortController }),
        ...thinkingOptions(options.effort),
    };
}

/**
 * Claude Code spreads these headers over its own defaults, so this is where a user agent wins.
 * The caller's existing headers come first, since the override is the more specific request.
 */
function customHeaders(env: NodeJS.ProcessEnv, userAgent: string | undefined): NodeJS.ProcessEnv {
    const identification = userAgent?.trim();
    if (identification === undefined || identification.length === 0) return {};
    const existing = env.ANTHROPIC_CUSTOM_HEADERS?.trim();
    const header = `User-Agent: ${identification}`;
    return {
        ANTHROPIC_CUSTOM_HEADERS:
            existing === undefined || existing.length === 0 ? header : `${existing}\n${header}`,
    };
}

// Session system messages stay in the conversation as positional reminders. Only the caller's
// instructions belong in the prompt, so a mid-conversation notice cannot rewrite the cached prefix.
function createSystemPrompt(basePrompt: string, context: SessionContext): string {
    return [basePrompt, context.instructions].filter(Boolean).join("\n\n");
}

function credentialEnvironment(credential: ClaudeCredential): NodeJS.ProcessEnv {
    if (credential.name === "claude-api-key") {
        return { ANTHROPIC_API_KEY: credential.credential.apiKey };
    }
    if (credential.name === "claude-auth-token") {
        return { ANTHROPIC_AUTH_TOKEN: credential.credential.authToken };
    }
    if (credential.name === "claude-oauth") {
        return { CLAUDE_CODE_OAUTH_TOKEN: credential.credential.accessToken };
    }
    credential.name satisfies "claude-code";
    return {};
}

function createClaudeMcpServer(
    tools: readonly SessionTool[],
    callTool?: (toolUseId: string) => Promise<CallToolResult>,
    toolSearchEnabled = false,
) {
    const instance = new McpServer(
        {
            name: RIG_MCP_SERVER_NAME,
            version: "happy-providers",
        },
        {
            capabilities: { tools: {} },
        },
    );
    instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: tools.map((tool) => toClaudeMcpToolDefinition(tool, toolSearchEnabled)),
    }));
    instance.server.setRequestHandler(CallToolRequestSchema, async (request) => {
        if (callTool === undefined) {
            return {
                content: [{ type: "text", text: "Tool execution is handled by Rig." }],
                isError: true,
            };
        }
        if (!Value.Check(claudeToolCallMetaSchema, request.params._meta)) {
            return {
                content: [
                    {
                        type: "text",
                        text: "Claude Code did not identify which tool call this invocation answers.",
                    },
                ],
                isError: true,
            };
        }
        return callTool(request.params._meta["claudecode/toolUseId"]);
    });
    return {
        type: "sdk" as const,
        name: RIG_MCP_SERVER_NAME,
        instance,
    };
}

// Claude Code stamps every MCP tools/call with the originating tool_use block ID, which is the
// same callId Rig streams on toolcall_start. Rig pins the SDK, so the stamp is required: an
// invocation without it cannot be paired with a streamed call and is refused outright.
const claudeToolCallMetaSchema = Type.Object({
    "claudecode/toolUseId": Type.String({ minLength: 1 }),
});

export function claudeSdkBuiltInToolNames(tools: readonly SessionTool[]): string[] {
    return tools.flatMap((tool) => (tool.server === undefined ? [] : [tool.server.type]));
}

function hasClaudeToolSearch(tools: readonly SessionTool[]): boolean {
    return tools.some((tool) => tool.server?.type === "ToolSearch");
}

export function toClaudeMcpToolDefinition(tool: SessionTool, toolSearchEnabled = false) {
    const description = claudeMcpToolDescription(tool);
    return {
        name: tool.name,
        description,
        inputSchema: toLlmParametersSchema(tool.parameters),
        ...(toolSearchEnabled && tool.defer === true
            ? {}
            : { _meta: { "anthropic/alwaysLoad": true } }),
    };
}

function claudeMcpToolDescription(tool: SessionTool): string {
    const description =
        tool.description === undefined || tool.description.trim().length === 0
            ? `Run ${tool.name} through Rig.`
            : tool.description;
    const keywords = [...new Set((tool.searchKeywords ?? []).map((value) => value.trim()))].filter(
        Boolean,
    );
    return keywords.length === 0
        ? description
        : `${description}\n\nSearch keywords: ${keywords.join(", ")}`;
}

function toAbortController(signal: AbortSignal | undefined): {
    abortController?: AbortController;
    cleanup: () => void;
} {
    if (signal === undefined) return { cleanup: () => {} };
    const controller = new AbortController();
    if (signal.aborted) controller.abort(signal.reason);
    const abort = () => controller.abort(signal.reason);
    if (!signal.aborted) signal.addEventListener("abort", abort, { once: true });
    return {
        abortController: controller,
        cleanup: () => signal.removeEventListener("abort", abort),
    };
}

function withoutClaudeCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const sanitized = { ...env };
    delete sanitized.ANTHROPIC_API_KEY;
    delete sanitized.ANTHROPIC_AUTH_TOKEN;
    delete sanitized.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR;
    delete sanitized.CLAUDE_CODE_OAUTH_TOKEN;
    delete sanitized.CLAUDE_CODE_USE_BEDROCK;
    delete sanitized.CLAUDE_CODE_USE_FOUNDRY;
    delete sanitized.CLAUDE_CODE_USE_VERTEX;
    return sanitized;
}

function thinkingOptions(
    effort: SessionReasoningEffort | undefined,
): Partial<Pick<ClaudeSdkOptions, "effort" | "thinking">> {
    // Left to the SDK, which already thinks adaptively; the capture shows the native client sends
    // no thinking configuration of its own when the caller states no preference.
    if (effort === undefined) return {};
    if (effort === "off") return { thinking: { type: "disabled" } };
    const sdkEffort =
        effort === "minimal"
            ? "low"
            : effort === "xhigh"
              ? "xhigh"
              : effort === "max"
                ? "max"
                : effort;
    return {
        effort: sdkEffort,
        thinking: { type: "adaptive", display: "summarized" },
    };
}
