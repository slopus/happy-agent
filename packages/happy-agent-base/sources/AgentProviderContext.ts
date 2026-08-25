import type {
    SessionAssistantBlock,
    SessionEvent,
    SessionMessage,
    SessionToolResultMessage,
} from "@slopus/happy-providers";
import { createId } from "@paralleldrive/cuid2";
import { Value } from "@sinclair/typebox/value";

import type { AgentRecord } from "./AgentPersistence.js";
import { cuid2Schema } from "./AgentMetadata.js";

/** Replace one response-local provider ID before a stream event leaves the provider boundary. */
export function baseSessionEvent(
    event: SessionEvent,
    responseToolIds: Map<string, string>,
    contextToolIds: Map<string, string>,
    persistedToolIds: ReadonlySet<string>,
): SessionEvent {
    if (event.type === "block_reset") {
        // A reset discards only what the response has not durably persisted. A tool block
        // already appended to the store stays in the context, so its provider mapping must
        // survive for the next request to translate it.
        for (const id of responseToolIds.values()) {
            if (!persistedToolIds.has(id)) contextToolIds.delete(id);
        }
        responseToolIds.clear();
        return event;
    }
    if (event.type === "toolcall_start") {
        if (responseToolIds.has(event.callId)) {
            throw new Error("The provider emitted a duplicate tool-call identity.");
        }
        const id = createId();
        responseToolIds.set(event.callId, id);
        contextToolIds.set(id, event.callId);
        const { callId: _callId, vendor: _vendor, ...rest } = event;
        return { ...rest, callId: id };
    }
    if (event.type === "toolcall_end") {
        const { callId: _callId, ...rest } = event;
        const { vendor: _vendor, ...publicRest } = rest as typeof rest & { vendor?: unknown };
        return { ...publicRest, callId: requireBaseId(responseToolIds, event.callId) };
    }
    if (
        event.type === "toolcall_delta" ||
        event.type === "toolcall_result_delta" ||
        event.type === "toolcall_result_end"
    ) {
        return { ...event, callId: requireBaseId(responseToolIds, event.callId) };
    }
    if (event.type === "toolcall_result_start") {
        const { callId: _callId, vendor: _vendor, ...rest } = event;
        return { ...rest, callId: requireBaseId(responseToolIds, event.callId) };
    }
    return event;
}

/** Persist a canonical assistant block with its provider ID beside it in context storage. */
export function assistantContextRecord(
    block: SessionAssistantBlock,
    toolIds: ReadonlyMap<string, string>,
): AgentRecord {
    if (block.type !== "tool_call" && block.type !== "tool_result") {
        return { type: "block", block };
    }
    const id = block.callId;
    return {
        type: "block",
        id,
        block: { ...block, callId: requireProviderId(toolIds, id) },
    };
}

/** Persist a canonical client-tool result with its provider ID beside it in context storage. */
export function toolContextRecord(
    message: SessionToolResultMessage,
    toolIds: ReadonlyMap<string, string>,
): AgentRecord {
    const id = message.callId;
    return {
        type: "tool",
        id,
        message: { ...message, callId: requireProviderId(toolIds, id) },
    };
}

/** Translate Base's canonical context only at the point where a provider receives it. */
export function providerContextMessages(
    messages: readonly SessionMessage[],
    toolIds: ReadonlyMap<string, string>,
): SessionMessage[] {
    return remapMessages(messages, (id) => requireProviderId(toolIds, id));
}

/**
 * Accept provider-returned context into Base's canonical identity space.
 *
 * Existing IDs are reused by provider ID and occurrence. A provider-created value receives a new
 * CUID2. Imported portable context may opt into retaining IDs that are already valid CUID2s.
 */
export function baseContextMessages(
    messages: readonly SessionMessage[],
    previous: ReadonlyMap<string, string> = new Map(),
    preservePortableIds = false,
) {
    const callIds = idsByProvider(previous);
    const resultIds = idsByProvider(previous);
    const assignedCalls = new Map<string, string[]>();
    const toolIds = new Map<string, string>();
    const remember = (id: string, callId: string): string => {
        const current = toolIds.get(id);
        if (current !== undefined && current !== callId) {
            throw new Error(`Base tool identity "${id}" maps to two provider call IDs.`);
        }
        toolIds.set(id, callId);
        return id;
    };
    const freshId = (callId: string): string => {
        if (preservePortableIds && Value.Check(cuid2Schema, callId) && !toolIds.has(callId)) {
            return callId;
        }
        let id = createId();
        while (toolIds.has(id)) id = createId();
        return id;
    };
    const callIdentity = (callId: string): string => {
        const id = callIds.get(callId)?.shift() ?? freshId(callId);
        const assigned = assignedCalls.get(callId) ?? [];
        assigned.push(id);
        assignedCalls.set(callId, assigned);
        return remember(id, callId);
    };
    const resultIdentity = (callId: string): string =>
        remember(
            assignedCalls.get(callId)?.shift() ?? resultIds.get(callId)?.shift() ?? freshId(callId),
            callId,
        );

    const canonical = messages.map((message): SessionMessage => {
        if (message.role === "assistant") {
            return {
                ...message,
                content: message.content.map((block): SessionAssistantBlock => {
                    if (block.type === "tool_call") {
                        return { ...block, callId: callIdentity(block.callId) };
                    }
                    if (block.type === "tool_result") {
                        return { ...block, callId: resultIdentity(block.callId) };
                    }
                    return block;
                }),
            };
        }
        if (message.role === "tool") {
            return { ...message, callId: resultIdentity(message.callId) };
        }
        return message;
    });
    return { messages: canonical, toolIds };
}

/** Durable mapping carried by a complete compaction context. */
export function storedContextToolIds(
    toolIds: ReadonlyMap<string, string>,
): readonly (readonly [id: string, callId: string])[] {
    return [...toolIds];
}

/** Rebuild Base's canonical context and its private provider mapping from append-only records. */
export function contextFromRecords(records: readonly AgentRecord[]) {
    let messages: SessionMessage[] = [];
    let toolIds = new Map<string, string>();
    const remember = (id: string, callId: string): void => {
        if (!Value.Check(cuid2Schema, id)) {
            throw new Error("A context tool value is missing its Base ID.");
        }
        const current = toolIds.get(id);
        if (current !== undefined && current !== callId) {
            throw new Error(`Base tool identity "${id}" maps to two provider call IDs.`);
        }
        toolIds.set(id, callId);
    };
    for (const record of records) {
        if (record.type === "compaction") {
            messages = [...record.messages];
            toolIds = new Map();
            for (const [id, callId] of record.contextToolIds) remember(id, callId);
            continue;
        }
        if (record.type === "tool") {
            remember(record.id, record.message.callId);
            messages.push({ ...record.message, callId: record.id });
            continue;
        }
        if (record.type === "user" || record.type === "system") {
            messages.push(record.message);
            continue;
        }
        let block: SessionAssistantBlock = record.block;
        if (record.block.type === "tool_call" || record.block.type === "tool_result") {
            if (!("id" in record)) {
                throw new Error("A context tool block is missing its Base ID.");
            }
            remember(record.id, record.block.callId);
            block = { ...record.block, callId: record.id };
        }
        const last = messages[messages.length - 1];
        if (last?.role === "assistant") {
            messages[messages.length - 1] = {
                role: "assistant",
                content: [...last.content, block],
            };
        } else {
            messages.push({ role: "assistant", content: [block] });
        }
    }
    // Validate that every canonical tool value can cross the provider boundary after reload.
    providerContextMessages(messages, toolIds);
    return { messages, toolIds };
}

function remapMessages(
    messages: readonly SessionMessage[],
    callId: (id: string) => string,
): SessionMessage[] {
    return messages.map((message): SessionMessage => {
        if (message.role === "assistant") {
            return {
                ...message,
                content: message.content.map((block): SessionAssistantBlock => {
                    if (block.type !== "tool_call" && block.type !== "tool_result") return block;
                    return { ...block, callId: callId(block.callId) };
                }),
            };
        }
        if (message.role === "tool") return { ...message, callId: callId(message.callId) };
        return message;
    });
}

function idsByProvider(toolIds: ReadonlyMap<string, string>): Map<string, string[]> {
    const byProvider = new Map<string, string[]>();
    for (const [id, callId] of toolIds) {
        const ids = byProvider.get(callId) ?? [];
        ids.push(id);
        byProvider.set(callId, ids);
    }
    return byProvider;
}

function requireBaseId(toolIds: ReadonlyMap<string, string>, providerId: string): string {
    const id = toolIds.get(providerId);
    if (id === undefined) {
        throw new Error("The provider emitted a tool event without a matching start.");
    }
    return id;
}

function requireProviderId(toolIds: ReadonlyMap<string, string>, id: string): string {
    const providerId = toolIds.get(id);
    if (providerId === undefined) {
        throw new Error(`Base tool identity "${id}" has no provider context ID.`);
    }
    return providerId;
}
