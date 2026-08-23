import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    MAX_HISTORY_RECORDED_TOOL_OUTPUT_LENGTH,
    type HistoryBlock,
    type HistoryMessage,
    type HistoryToolPresentation,
} from "../history/index.js";
import { toolCallResource, type MessageResourceOptions } from "./ApiToolPresentation.js";

type ReviewedHistoryToolCall = Extract<HistoryBlock, { type: "tool_call" }> & {
    readonly elevated: boolean;
    readonly review: NonNullable<Extract<HistoryBlock, { type: "tool_call" }>["review"]>;
};

const providerTextBlockSchema = Type.Object(
    { type: Type.Literal("text"), text: Type.String() },
    { additionalProperties: true },
);
const providerThinkingBlockSchema = Type.Object(
    { type: Type.Literal("thinking"), thinking: Type.String() },
    { additionalProperties: true },
);
const providerImageBlockSchema = Type.Object(
    {
        type: Type.Literal("image"),
        mediaType: Type.String(),
        data: Type.Optional(Type.String()),
    },
    { additionalProperties: true },
);
const providerToolCallBlockSchema = Type.Object(
    {
        type: Type.Literal("toolCall"),
        id: Type.Optional(Type.String()),
        callId: Type.Optional(Type.String()),
        name: Type.Optional(Type.String()),
        arguments: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: true },
);
const providerRenderedBlockSchema = Type.Union([providerTextBlockSchema, providerImageBlockSchema]);
const providerToolResultBlockSchema = Type.Object(
    {
        type: Type.Literal("tool_result"),
        toolCallId: Type.String(),
        display: Type.Optional(Type.String()),
        rendered: Type.Optional(Type.Array(providerRenderedBlockSchema)),
        isError: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: true },
);
const providerContentSchema = Type.Array(Type.Unknown());

/**
 * Whether a durable message was injected for the model alone and must stay out of the public API.
 *
 * The message remains in durable history — history reads, Auto review evidence, and the model's
 * own context still see it — but no API consumer is shown content the daemon marked internal.
 */
export function messageHiddenFromUser(message: HistoryMessage): boolean {
    return message.hideFromUser === true;
}

/** Project one durable history message into the public message shape. */
export function messageResource(
    message: HistoryMessage,
    options: MessageResourceOptions = {},
): Record<string, unknown> {
    const role = historyRole(message.role);
    return {
        id: message.recordId,
        role,
        createdAt: message.at ?? 0,
        content: historyBlocks(message.blocks, options),
        metadata: {
            ...(message.provider === undefined ? {} : { providerId: message.provider }),
            ...(message.model === undefined ? {} : { modelId: message.model }),
            ...(message.senderAgentId === undefined
                ? {}
                : { senderAgentId: message.senderAgentId }),
        },
        ...(role === "user" && message.clientMetadata !== undefined
            ? { clientMetadata: message.clientMetadata }
            : {}),
        ...(role === "user"
            ? {
                  status: "accepted",
                  delivery: message.delivery ?? "queue",
                  mode: message.mode ?? null,
                  runId: message.runId ?? null,
              }
            : {}),
    };
}

/** Project the live provider reducer's partial message content into the same public block shape. */
export function providerMessageContent(
    value: unknown,
    reviewedCalls: ReadonlyMap<string, ReviewedHistoryToolCall> = new Map(),
    resultPresentations: ReadonlyMap<string, HistoryToolPresentation> = new Map(),
): readonly Record<string, unknown>[] | undefined {
    if (!Value.Check(providerContentSchema, value)) return undefined;
    const results = new Map<string, Static<typeof providerToolResultBlockSchema>>();
    for (const candidate of value) {
        const result = checked(providerToolResultBlockSchema, candidate);
        if (result !== undefined) results.set(result.toolCallId, result);
    }
    return value.flatMap((candidate): Record<string, unknown>[] => {
        const text = checked(providerTextBlockSchema, candidate);
        if (text !== undefined) return [{ type: "text", text: text.text }];
        const thinking = checked(providerThinkingBlockSchema, candidate);
        if (thinking !== undefined) {
            return [{ type: "reasoning", text: thinking.thinking }];
        }
        const image = checked(providerImageBlockSchema, candidate);
        if (image !== undefined) {
            return [
                {
                    type: "image",
                    mimeType: image.mediaType,
                    data: image.data ?? "",
                },
            ];
        }
        const call = checked(providerToolCallBlockSchema, candidate);
        if (call === undefined) return [];
        const callId = call.id ?? call.callId ?? "unknown";
        const result = results.get(callId);
        const reviewed = reviewedCalls.get(callId);
        const presentation = resultPresentations.get(callId);
        return [
            toolCallResource(
                {
                    id: callId,
                    name: call.name ?? "tool",
                    status:
                        result === undefined
                            ? "running"
                            : result.isError === true
                              ? "failed"
                              : "completed",
                    arguments: call.arguments ?? {},
                    ...(result === undefined ? {} : { output: providerToolOutput(result) }),
                    ...(result === undefined || presentation === undefined ? {} : { presentation }),
                    ...(reviewed === undefined
                        ? {}
                        : { elevated: reviewed.elevated, review: reviewed.review }),
                },
                {},
            ),
        ];
    });
}

function historyBlocks(
    blocks: readonly HistoryBlock[],
    options: MessageResourceOptions,
): readonly Record<string, unknown>[] {
    const results = new Map<string, Extract<HistoryBlock, { type: "tool_result" }>>();
    for (const block of blocks) {
        if (block.type === "tool_result") results.set(block.callId, block);
    }
    return blocks
        .filter((block) => block.type !== "tool_result")
        .map((block): Record<string, unknown> => {
            if (block.type === "text") return { type: "text", text: block.text };
            if (block.type === "thinking") {
                return { type: "reasoning", text: block.thinking };
            }
            if (block.type === "image") {
                return {
                    type: "image",
                    mimeType: block.mediaType,
                    data: block.data ?? "",
                };
            }
            if (block.type === "compaction") {
                return {
                    type: "compaction",
                    trigger: block.trigger,
                    status: block.status,
                    tokensBefore: block.tokensBefore,
                    tokensAfter: block.tokensAfter,
                    failureReason: block.failureReason,
                    startedAt: block.startedAt,
                    completedAt: block.completedAt,
                };
            }
            const result = results.get(block.callId);
            return toolCallResource(
                {
                    id: block.callId,
                    name: block.name,
                    status:
                        result === undefined
                            ? "running"
                            : result.isError === true
                              ? "failed"
                              : "completed",
                    arguments: block.arguments,
                    ...(result === undefined ? {} : { output: result.output ?? "" }),
                    ...(result?.presentation === undefined
                        ? {}
                        : { presentation: result.presentation }),
                    ...(block.elevated === undefined || block.review === undefined
                        ? {}
                        : { elevated: block.elevated, review: block.review }),
                },
                options,
            );
        });
}

/** Review annotations from a durable message, keyed by Agent Base's stable call identity. */
export function reviewedToolCalls(
    message: HistoryMessage | undefined,
): ReadonlyMap<string, ReviewedHistoryToolCall> {
    const reviewed = new Map<string, ReviewedHistoryToolCall>();
    for (const block of message?.blocks ?? []) {
        if (
            block.type === "tool_call" &&
            block.elevated !== undefined &&
            block.review !== undefined
        ) {
            reviewed.set(block.callId, block as ReviewedHistoryToolCall);
        }
    }
    return reviewed;
}

/** Result-derived presentations from a durable assistant message, by Base call identity. */
export function toolResultPresentations(
    message: HistoryMessage | undefined,
): ReadonlyMap<string, HistoryToolPresentation> {
    const presentations = new Map<string, HistoryToolPresentation>();
    for (const block of message?.blocks ?? []) {
        if (block.type === "tool_result" && block.presentation !== undefined) {
            presentations.set(block.callId, block.presentation);
        }
    }
    return presentations;
}

function providerToolOutput(result: Static<typeof providerToolResultBlockSchema>): string {
    if (result.rendered === undefined) return result.display ?? "";
    const output = result.rendered
        .map((block) => (block.type === "text" ? block.text : `[${block.mediaType} image output]`))
        .join("\n");
    if (output.length <= MAX_HISTORY_RECORDED_TOOL_OUTPUT_LENGTH) return output;
    const suffix = `\n...[truncated ${String(
        Math.max(0, output.length - MAX_HISTORY_RECORDED_TOOL_OUTPUT_LENGTH),
    )} chars]`;
    const retained = Math.max(0, MAX_HISTORY_RECORDED_TOOL_OUTPUT_LENGTH - suffix.length);
    return `${output.slice(0, retained)}${suffix}`;
}

function checked<Schema extends TSchema>(
    schema: Schema,
    value: unknown,
): Static<Schema> | undefined {
    return Value.Check(schema, value) ? (value as Static<Schema>) : undefined;
}

function historyRole(role: HistoryMessage["role"]): string {
    if (role === "assistant" || role === "agent") return "agent";
    if (role === "error") return "service";
    return role;
}
