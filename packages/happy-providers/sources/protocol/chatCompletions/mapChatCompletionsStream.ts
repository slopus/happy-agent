import type { SessionEvent } from "@/core/SessionEvent.js";
import type { SessionTool } from "@/core/SessionTool.js";
import type { SessionUsage } from "@/core/SessionUsage.js";
import { EMPTY_SESSION_USAGE } from "@/core/SessionUsage.js";
import { EmptyResponseError } from "@/core/EmptyResponseError.js";
import type { ChatCompletionsChunk } from "./ChatCompletionsConnection.js";
import { toolName } from "./createChatCompletionsRequest.js";

export async function* mapChatCompletionsStream(
    stream: AsyncIterable<ChatCompletionsChunk>,
    tools: readonly SessionTool[],
): AsyncGenerator<SessionEvent> {
    let active: "text" | "reasoning" | undefined;
    let finish: string | undefined;
    let hasContent = false;
    let usage: SessionUsage = EMPTY_SESSION_USAGE;
    const calls = new Map<
        number,
        { id?: string; name: string; arguments: string; started: boolean }
    >();
    const definitions = new Map(tools.map((tool) => [toolName(tool), tool]));
    for await (const chunk of stream) {
        if (chunk.usage) {
            usage = {
                input: chunk.usage.prompt_tokens,
                output: chunk.usage.completion_tokens,
                cacheRead: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
                cacheWrite: 0,
                totalTokens: chunk.usage.prompt_tokens + chunk.usage.completion_tokens,
            };
        }
        const choice = chunk.choices.find((item) => item.index === 0);
        if (choice === undefined) continue;
        if (choice.finish_reason !== null) finish = choice.finish_reason;
        for (const [kind, delta] of [
            ["reasoning", choice.delta.reasoning_content],
            ["text", choice.delta.content],
        ] as const) {
            if (!delta) continue;
            if (active !== kind) {
                if (active !== undefined)
                    yield { type: active === "text" ? "text_end" : "reasoning_end" };
                active = kind;
                yield { type: kind === "text" ? "text_start" : "reasoning_start" };
            }
            hasContent = true;
            yield { type: kind === "text" ? "text_delta" : "reasoning_delta", delta };
        }
        for (const update of choice.delta.tool_calls ?? []) {
            if (active !== undefined) {
                yield { type: active === "text" ? "text_end" : "reasoning_end" };
                active = undefined;
            }
            let call = calls.get(update.index);
            if (call === undefined) {
                call = { name: "", arguments: "", started: false };
                calls.set(update.index, call);
            }
            if (call.id !== undefined && update.id !== undefined && update.id !== call.id) {
                throw new Error("Bedrock changed a tool call's identity while streaming.");
            }
            if (update.id !== undefined) call.id = update.id;
            if (update.function?.name) {
                if (call.started && update.function.name !== call.name)
                    throw new Error("Bedrock changed a tool call's name while streaming.");
                if (!call.started) call.name += update.function.name;
            }
            const delta = update.function?.arguments;
            if (delta) call.arguments += delta;
            if (call.started) {
                if (delta) yield { type: "toolcall_delta", callId: call.id!, delta };
            } else if (
                call.id &&
                definitions.has(call.name) &&
                !tools.some(
                    (tool) => toolName(tool) !== call.name && toolName(tool).startsWith(call.name),
                )
            ) {
                const definition = definitions.get(call.name)!;
                call.started = true;
                yield {
                    type: "toolcall_start",
                    callId: call.id,
                    name: definition.name,
                    ...(definition.namespace === undefined
                        ? {}
                        : { namespace: definition.namespace }),
                };
                if (call.arguments)
                    yield { type: "toolcall_delta", callId: call.id, delta: call.arguments };
            }
            hasContent = true;
        }
    }
    if (finish === undefined)
        throw new Error("Bedrock closed the chat stream before reporting completion.");
    if (!hasContent) throw new EmptyResponseError("Bedrock");
    if (active !== undefined) yield { type: active === "text" ? "text_end" : "reasoning_end" };
    for (const call of calls.values()) {
        if (!call.id || !call.name)
            throw new Error("Bedrock returned a tool call without an identity or name.");
        if (!call.started) {
            const definition = definitions.get(call.name);
            yield {
                type: "toolcall_start",
                callId: call.id,
                name: definition?.name ?? call.name,
                ...(definition?.namespace === undefined ? {} : { namespace: definition.namespace }),
            };
            if (call.arguments)
                yield { type: "toolcall_delta", callId: call.id, delta: call.arguments };
        }
        yield {
            type: "toolcall_end",
            callId: call.id,
            arguments: call.arguments,
            ...(finish === "tool_calls" ? {} : { incomplete: true }),
        };
    }
    if (!["stop", "tool_calls", "length"].includes(finish)) {
        throw new Error(`Bedrock could not finish the response (${finish}).`);
    }
    if (finish === "tool_calls" && calls.size === 0)
        throw new Error("Bedrock requested tool execution without returning a tool call.");
    yield { type: "token_usage", usage };
    yield {
        type: "done",
        state: finish === "length" ? "length" : finish === "tool_calls" ? "tool_call" : "normal",
        tokens: { input: usage.input, output: usage.output },
    };
}
