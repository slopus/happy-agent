import { createHash } from "node:crypto";

import type { SessionReasoningEffort, SessionRunRequest } from "@/core/SessionRunRequest.js";
import type { SessionTool } from "@/core/SessionTool.js";
import {
    claudeSdkBuiltInToolNames,
    hasClaudeToolSearch,
    toClaudeMcpToolDefinition,
} from "@/vendors/claude/impl/toClaudeSdkOptions.js";

const toolFingerprints = new WeakMap<readonly SessionTool[], string>();

/**
 * Names the configuration a live Claude query was started with, so a later turn can tell whether
 * it may continue that query or has to start another.
 *
 * Callers hand over richer objects than `SessionTool`: an agent tool also carries its return
 * schema, executor, and review hooks. The key covers the tools exactly as Claude is sent them,
 * built by the same functions that build the query, so it can neither miss a change Claude would
 * see nor serialize a field Claude never receives. That matters for MCP tools, whose return
 * schema references each level of its bounded JSON value twice and grows to megabytes per tool
 * once written out. The fingerprint is computed once per tools array, which a session keeps for
 * its lifetime.
 */
export function claudeQueryKey(options: {
    compaction: boolean;
    effort: SessionReasoningEffort | undefined;
    model: string;
    structuredOutput?: SessionRunRequest["structuredOutput"];
    systemPrompt: string;
    tools: readonly SessionTool[];
}): string {
    return JSON.stringify({
        compaction: options.compaction,
        effort: options.effort,
        model: options.model,
        ...(options.structuredOutput === undefined
            ? {}
            : { structuredOutput: options.structuredOutput }),
        systemPrompt: options.systemPrompt,
        tools: claudeToolsFingerprint(options.tools),
    });
}

function claudeToolsFingerprint(tools: readonly SessionTool[]): string {
    const cached = toolFingerprints.get(tools);
    if (cached !== undefined) return cached;
    const toolSearchEnabled = hasClaudeToolSearch(tools);
    const wireTools = {
        builtIn: claudeSdkBuiltInToolNames(tools),
        mcp: tools
            .filter((tool) => tool.server === undefined)
            .map((tool) => toClaudeMcpToolDefinition(tool, toolSearchEnabled)),
    };
    const fingerprint = createHash("sha256").update(JSON.stringify(wireTools)).digest("base64");
    toolFingerprints.set(tools, fingerprint);
    return fingerprint;
}
