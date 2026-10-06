import type {
    SessionContext,
    SessionInputBlock,
    SessionOutputBlock,
} from "@/core/SessionContext.js";
import type { SessionTool } from "@/core/SessionTool.js";
import type { SessionRunRequest } from "@/core/SessionRunRequest.js";
import { toSessionAgentNotificationMessage } from "@/core/toSessionAgentNotificationMessage.js";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const kimiSummarySchema = Type.Object({
    type: Type.Literal("kimi_summary"),
    continuation: Type.String(),
});

export function createChatCompletionsRequest(options: {
    context: SessionContext;
    model: string;
    tools: readonly SessionTool[];
    request: SessionRunRequest;
    generation?: Readonly<Record<string, unknown>>;
}): object {
    const messages: object[] = [];
    if (options.context.instructions)
        messages.push({ role: "system", content: options.context.instructions });
    for (const original of options.context.messages) {
        const message =
            original.role === "agent" ? toSessionAgentNotificationMessage(original) : original;
        switch (message.role) {
            case "system":
            case "user":
                messages.push({ role: message.role, content: inputContent(message.content) });
                break;
            case "assistant": {
                const textBlocks = message.content.filter((block) => block.type === "text");
                const reasoning = message.content
                    .filter((block) => block.type === "reasoning")
                    .map((block) => block.text ?? "")
                    .join("");
                const calls = message.content.filter((block) => block.type === "tool_call");
                if (
                    calls.some((call) => call.server === true) ||
                    message.content.some((block) => block.type === "tool_result")
                ) {
                    throw new Error("Chat Completions cannot replay provider-owned tool results.");
                }
                messages.push({
                    role: "assistant",
                    ...(textBlocks.length === 0 ||
                    (calls.length > 0 && textBlocks.every((block) => !block.text.trim()))
                        ? {}
                        : { content: inputContent(textBlocks) }),
                    reasoning_content: reasoning,
                    ...(calls.length === 0
                        ? {}
                        : {
                              tool_calls: calls.map((call) => ({
                                  id: call.callId,
                                  type: "function",
                                  function: { name: toolName(call), arguments: call.arguments },
                              })),
                          }),
                });
                break;
            }
            case "tool":
                messages.push({
                    role: "tool",
                    tool_call_id: message.callId,
                    content: inputContent(message.content),
                });
                break;
            case "compaction":
                if (message.encryptedContent !== null)
                    throw new Error("Chat Completions cannot replay encrypted compaction.");
                if (message.content !== null)
                    messages.push({ role: "user", content: message.content });
                if (Value.Check(kimiSummarySchema, message.vendor))
                    messages.push({ role: "user", content: message.vendor.continuation });
                break;
        }
    }
    const tools = options.tools.map((tool) => {
        if (tool.server !== undefined || tool.grammar !== undefined) {
            throw new Error("This Bedrock model supports ordinary function tools only.");
        }
        return {
            type: "function",
            function: {
                name: toolName(tool),
                ...(tool.description === undefined ? {} : { description: tool.description }),
                parameters: tool.parameters ?? { type: "object", properties: {} },
            },
        };
    });
    if (new Set(options.tools.map(toolName)).size !== tools.length) {
        throw new Error(
            "Chat Completions tool names must be unique after namespace serialization.",
        );
    }
    return {
        model: options.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(tools.length === 0 ? {} : { tools }),
        ...options.generation,
        ...(options.request.structuredOutput === undefined
            ? {}
            : {
                  response_format: {
                      type: "json_schema",
                      json_schema: {
                          name: options.request.structuredOutput.name,
                          schema: options.request.structuredOutput.schema,
                      },
                  },
              }),
    };
}

export function toolName(tool: { name: string; namespace?: string }): string {
    return tool.namespace === undefined ? tool.name : `${tool.namespace}__${tool.name}`;
}

function inputContent(
    blocks: readonly (SessionInputBlock | SessionOutputBlock)[],
): string | object[] {
    if (blocks.length === 1 && blocks[0]?.type === "text") return blocks[0].text;
    return blocks.map((block) => {
        if (block.type === "tool_call_request")
            throw new Error("Tool requests must be consumed before inference.");
        return block.type === "text"
            ? { type: "text", text: block.text }
            : {
                  type: "image_url",
                  image_url: { url: `data:${block.mimeType};base64,${block.data}` },
              };
    });
}
