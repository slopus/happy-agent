import { createHash } from "node:crypto";

import type { SessionReasoningEffort, SessionRunRequest } from "@/core/SessionRunRequest.js";
import type { SessionTool } from "@/core/SessionTool.js";

const toolFingerprints = new WeakMap<readonly SessionTool[], string>();

/**
 * Names the configuration a live Claude query was started with, so a later turn can tell whether
 * it may continue that query or has to start another.
 *
 * Callers hand over richer objects than `SessionTool`: an agent tool also carries its return
 * schema, executor, and review hooks. Only the fields Claude is sent belong in the key. A return
 * schema can share subschemas — MCP's bounded JSON value schema references each level twice —
 * and stringifying it repeats every shared node, which grows to megabytes per tool and to
 * hundreds of megabytes for a session with a few dozen MCP tools. The tools are fingerprinted
 * once per array, since a session offers the same array on every turn of its loop.
 */
export function claudeQueryKey(options: {
    compaction: boolean;
    effort: SessionReasoningEffort | undefined;
    model: string;
    structuredOutput: SessionRunRequest["structuredOutput"] | undefined;
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
    const fingerprint = createHash("sha256")
        .update(JSON.stringify(tools.map(toWireTool)))
        .digest("base64");
    toolFingerprints.set(tools, fingerprint);
    return fingerprint;
}

function toWireTool(tool: SessionTool): SessionTool {
    return {
        name: tool.name,
        ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
        ...(tool.namespaceDescription === undefined
            ? {}
            : { namespaceDescription: tool.namespaceDescription }),
        ...(tool.server === undefined ? {} : { server: tool.server }),
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
        ...(tool.searchKeywords === undefined ? {} : { searchKeywords: tool.searchKeywords }),
        ...(tool.defer === undefined ? {} : { defer: tool.defer }),
        ...(tool.grammar === undefined ? {} : { grammar: tool.grammar }),
    };
}
