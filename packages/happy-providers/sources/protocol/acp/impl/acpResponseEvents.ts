import type * as acp from "@agentclientprotocol/sdk";

import type { SessionOutputBlock } from "@/core/SessionContext.js";
import type { SessionEvent } from "@/core/SessionEvent.js";

/** The MCP server name Happy's tools are served under inside the foreign agent. */
export const ACP_BRIDGE_NAME = "happy";

/**
 * One Happy response being assembled from a foreign agent's updates.
 *
 * The foreign agent executes its own tools, so each of its calls becomes a provider-owned server
 * call that is reported and settled inside the response. Happy never executes them.
 */
export class AcpResponseEvents {
    #open: "text" | "reasoning" | undefined;
    #outputCharacters = 0;
    readonly #calls = new Map<string, ForeignCall>();
    /** Calls settled in any earlier response of this session; later updates are dropped. */
    readonly #closed: Set<string>;

    constructor(closed: Set<string>) {
        this.#closed = closed;
    }

    get outputCharacters(): number {
        return this.#outputCharacters;
    }

    *update(update: acp.SessionUpdate): Generator<SessionEvent> {
        switch (update.sessionUpdate) {
            case "agent_message_chunk":
                if (update.content.type !== "text") return;
                yield* this.#openBlock("text");
                this.#outputCharacters += update.content.text.length;
                yield { type: "text_delta", delta: update.content.text };
                return;
            case "agent_thought_chunk":
                if (update.content.type !== "text") return;
                yield* this.#openBlock("reasoning");
                this.#outputCharacters += update.content.text.length;
                yield { type: "reasoning_delta", delta: update.content.text };
                return;
            case "tool_call":
            case "tool_call_update":
                yield* this.#toolCall(update);
                return;
            default:
                return;
        }
    }

    *close(): Generator<SessionEvent> {
        if (this.#open === "text") yield { type: "text_end" };
        if (this.#open === "reasoning") yield { type: "reasoning_end" };
        this.#open = undefined;
    }

    /** A response must not end with a foreign call it never settled. */
    *settleAll(): Generator<SessionEvent> {
        for (const [id, call] of this.#calls) {
            if (call.settled) continue;
            yield* this.#settle(
                id,
                [
                    {
                        type: "text",
                        text: "The agent had not finished this step when the response ended.",
                    },
                ],
                false,
            );
        }
    }

    *#openBlock(kind: "text" | "reasoning"): Generator<SessionEvent> {
        if (this.#open === kind) return;
        yield* this.close();
        this.#open = kind;
        yield kind === "text" ? { type: "text_start" } : { type: "reasoning_start" };
    }

    *#toolCall(update: acp.ToolCall | acp.ToolCallUpdate): Generator<SessionEvent> {
        const id = update.toolCallId;
        if (this.#closed.has(id)) return;
        let call = this.#calls.get(id);
        if (call === undefined) {
            if (isBridgeToolCall(update)) {
                // Already reported as a Happy tool call when the bridge received it.
                this.#closed.add(id);
                return;
            }
            yield* this.close();
            call = { settled: false };
            this.#calls.set(id, call);
            yield {
                type: "toolcall_start",
                callId: id,
                name: update.kind ?? "other",
                server: true,
            };
        }
        // Agents announce a call before its input is known and fill it in with later updates;
        // the call is recorded with what was known when it settled.
        if (update.title != null) call.title = update.title;
        if (update.rawInput !== undefined && !isEmptyObject(update.rawInput)) {
            call.input = update.rawInput;
        }
        if (update.locations != null && update.locations.length > 0) {
            call.paths = update.locations.map((location) => location.path);
        }
        if (update.status === "completed" || update.status === "failed") {
            yield* this.#settle(id, toolResultContent(update), update.status === "failed");
        }
    }

    *#settle(
        id: string,
        content: readonly SessionOutputBlock[],
        isError: boolean,
    ): Generator<SessionEvent> {
        const call = this.#calls.get(id);
        if (call === undefined || call.settled) return;
        call.settled = true;
        this.#closed.add(id);
        yield {
            type: "toolcall_end",
            callId: id,
            arguments: JSON.stringify({
                // ACP titles describe the invocation; history uses description for that text.
                ...(call.title === undefined ? {} : { title: call.title, description: call.title }),
                ...(call.input === undefined ? {} : { input: call.input }),
                ...(call.paths === undefined ? {} : { paths: call.paths }),
            }),
        };
        yield { type: "toolcall_result_start", callId: id };
        yield {
            type: "toolcall_result_end",
            callId: id,
            content,
            ...(isError ? { isError: true } : {}),
        };
    }
}

/** What is known so far about one of the foreign agent's own tool calls. */
interface ForeignCall {
    settled: boolean;
    title?: string;
    input?: unknown;
    paths?: string[];
}

function isEmptyObject(value: unknown): boolean {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0
    );
}

/**
 * Whether a foreign tool call is the agent's own record of calling Happy's bridge. Agents report
 * MCP calls differently; Antigravity names the server in `rawInput.ServerName`, others use the
 * `mcp__<server>__<tool>` convention in the title.
 */
function isBridgeToolCall(update: { title?: string | null; rawInput?: unknown }): boolean {
    const raw = update.rawInput;
    if (typeof raw === "object" && raw !== null) {
        const record = raw as Record<string, unknown>;
        for (const key of ["ServerName", "serverName", "server_name", "server"]) {
            if (record[key] === ACP_BRIDGE_NAME) return true;
        }
    }
    return update.title?.startsWith(`mcp__${ACP_BRIDGE_NAME}__`) === true;
}

function toolResultContent(update: {
    content?: acp.ToolCallContent[] | null;
    rawOutput?: unknown;
}): SessionOutputBlock[] {
    const blocks: SessionOutputBlock[] = [];
    for (const item of update.content ?? []) {
        if (item.type === "content") {
            if (item.content.type === "text")
                blocks.push({ type: "text", text: item.content.text });
            if (item.content.type === "image") {
                blocks.push({
                    type: "image",
                    data: item.content.data,
                    mimeType: item.content.mimeType,
                });
            }
        } else if (item.type === "diff") {
            blocks.push({ type: "text", text: `Edited ${item.path}\n${item.newText}` });
        } else if (item.type === "terminal") {
            blocks.push({ type: "text", text: `Terminal ${item.terminalId}` });
        }
    }
    if (blocks.length > 0) return blocks;
    const raw = update.rawOutput;
    if (typeof raw === "string") return [{ type: "text", text: raw }];
    if (raw !== undefined && raw !== null) return [{ type: "text", text: JSON.stringify(raw) }];
    return [{ type: "text", text: "Done." }];
}
