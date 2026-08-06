import { randomUUID } from "node:crypto";

import {
    query as defaultClaudeSdkQuery,
    type Options as ClaudeSdkOptions,
} from "@anthropic-ai/claude-agent-sdk";

import type {
    ClaudeAuxiliaryQueryRequest,
    ClaudeAuxiliaryQueryResponse,
} from "@/vendors/claude/ClaudeAuxiliaryQuery.js";
import type { ClaudeSessionOptions } from "@/vendors/claude/ClaudeSession.js";
import { toClaudeSdkOptions } from "@/vendors/claude/impl/toClaudeSdkOptions.js";

export async function runClaudeAuxiliaryQuery(
    options: Pick<
        ClaudeSessionOptions,
        "credential" | "env" | "pathToClaudeCodeExecutable" | "query" | "userAgent"
    > & {
        model: string;
        request: ClaudeAuxiliaryQueryRequest;
    },
): Promise<ClaudeAuxiliaryQueryResponse> {
    const sdkOptions = toClaudeSdkOptions({
        ...(options.request.signal === undefined ? {} : { abort: options.request.signal }),
        context: { instructions: "", messages: [] },
        credential: options.credential,
        env: options.env ?? process.env,
        model: options.model,
        ...(options.pathToClaudeCodeExecutable === undefined
            ? {}
            : { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable }),
        sessionId: randomUUID(),
        systemPrompt: options.request.systemPrompt,
        tools: [],
        ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
    });
    configureBuiltinTools(sdkOptions, options.request.tools ?? []);
    const stream = (options.query ?? defaultClaudeSdkQuery)({
        prompt: options.request.prompt,
        options: sdkOptions,
    });
    const content: unknown[] = [];
    try {
        for await (const message of stream) {
            if (message.type === "assistant") {
                if (message.error !== undefined) {
                    throw new Error(`Claude auxiliary inference failed: ${message.error}`);
                }
                content.push(...message.message.content);
            }
            // What a built-in tool actually found comes back on a user message, because that is
            // where a tool result belongs in a conversation. Keeping only the assistant's half
            // left the caller with the helper's summary of the work and no way to see the work:
            // for a search, the pages it consulted arrive here and nowhere else.
            if (message.type === "user" && Array.isArray(message.message.content)) {
                content.push(...message.message.content);
            }
            if (message.type === "result" && (message.subtype !== "success" || message.is_error)) {
                const detail =
                    message.subtype === "success"
                        ? message.result
                        : message.errors.join("\n").trim();
                throw new Error(detail || "Claude auxiliary inference failed.");
            }
        }
        return { content };
    } finally {
        stream.close();
    }
}

function configureBuiltinTools(options: ClaudeSdkOptions, tools: readonly "WebSearch"[]): void {
    options.allowedTools = [...tools];
    options.tools = [...tools];
}
