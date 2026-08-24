import type {
    SessionAssistantBlock,
    SessionAssistantMessage,
    SessionOutputBlock,
} from "@/core/SessionContext.js";
import type { SessionEvent } from "@/core/SessionEvent.js";

type MutableTextBlock = { type: "text"; text: string };
type MutableReasoningBlock = { type: "reasoning"; text?: string; reasoning?: string };
type MutableToolCallBlock = {
    type: "tool_call";
    callId: string;
    name: string;
    namespace?: string;
    arguments: string;
    incomplete?: boolean;
    vendor?: any;
    server?: true;
};
type MutableToolResultBlock = {
    type: "tool_result";
    callId: string;
    content: readonly SessionOutputBlock[];
    isError?: boolean;
    incomplete?: boolean;
    vendor?: any;
};
type MutableAssistantBlock =
    | MutableTextBlock
    | MutableReasoningBlock
    | MutableToolCallBlock
    | MutableToolResultBlock;

/** Reconstructs one ordered assistant message from a session run's block events. */
export class SessionAssistantMessageAccumulator {
    private readonly content: MutableAssistantBlock[] = [];
    private checkpoint: number | undefined;
    private text: MutableTextBlock | undefined;
    private reasoning: MutableReasoningBlock | undefined;
    private readonly toolCalls = new Map<string, MutableToolCallBlock>();
    private readonly toolResults = new Map<string, MutableToolResultBlock>();

    add(event: SessionEvent): void {
        if (event.type === "block_start") {
            if (this.checkpoint !== undefined) {
                throw new Error("A session event block is already open.");
            }
            this.checkpoint = this.content.length;
            return;
        }
        if (event.type === "block_stop") {
            if (this.checkpoint === undefined) throw new Error("No session event block is open.");
            this.checkpoint = undefined;
            this.clearActiveBlocks();
            return;
        }
        if (event.type === "block_reset") {
            if (this.checkpoint === undefined) throw new Error("No session event block is open.");
            this.content.length = this.checkpoint;
            this.checkpoint = undefined;
            this.clearActiveBlocks();
            return;
        }
        if (event.type === "text_start") {
            if (this.text !== undefined || this.reasoning !== undefined) {
                throw new Error("Text and reasoning blocks must not interleave.");
            }
            this.text = { type: "text", text: "" };
            this.content.push(this.text);
            return;
        }
        if (event.type === "text_delta") {
            if (this.text === undefined) throw new Error("Text delta arrived without text_start.");
            this.text.text += event.delta;
            return;
        }
        if (event.type === "text_end") {
            if (this.text === undefined) throw new Error("text_end arrived without text_start.");
            this.text = undefined;
            return;
        }
        if (event.type === "reasoning_start") {
            if (this.text !== undefined || this.reasoning !== undefined) {
                throw new Error("Text and reasoning blocks must not interleave.");
            }
            this.reasoning = { type: "reasoning" };
            this.content.push(this.reasoning);
            return;
        }
        if (event.type === "reasoning_delta") {
            if (this.reasoning === undefined) {
                throw new Error("Reasoning delta arrived without reasoning_start.");
            }
            this.reasoning.text = (this.reasoning.text ?? "") + event.delta;
            return;
        }
        if (event.type === "reasoning_end") {
            if (this.reasoning === undefined) {
                throw new Error("reasoning_end arrived without reasoning_start.");
            }
            if (event.reasoning !== undefined) this.reasoning.reasoning = event.reasoning;
            this.reasoning = undefined;
            return;
        }
        if (event.type === "toolcall_start") {
            const block: MutableToolCallBlock = {
                type: "tool_call",
                callId: event.callId,
                name: event.name,
                ...(event.namespace === undefined ? {} : { namespace: event.namespace }),
                arguments: "",
                ...(event.vendor === undefined ? {} : { vendor: event.vendor }),
                ...(event.server === true ? { server: true } : {}),
            };
            this.toolCalls.set(event.callId, block);
            this.content.push(block);
            return;
        }
        if (event.type === "toolcall_delta") {
            const block = this.toolCalls.get(event.callId);
            if (block === undefined) throw new Error("Tool-call delta arrived without a start.");
            block.arguments += event.delta;
            return;
        }
        if (event.type === "toolcall_end") {
            const block = this.toolCalls.get(event.callId);
            if (block === undefined) throw new Error("Tool-call end arrived without a start.");
            block.arguments = event.arguments;
            if (event.vendor !== undefined) block.vendor = event.vendor;
            if (event.incomplete === true) block.incomplete = true;
            this.toolCalls.delete(event.callId);
            return;
        }
        if (event.type === "toolcall_result_start") {
            const block: MutableToolResultBlock = {
                type: "tool_result",
                callId: event.callId,
                content: [],
                ...(event.vendor === undefined ? {} : { vendor: event.vendor }),
            };
            this.toolResults.set(event.callId, block);
            this.content.push(block);
            return;
        }
        if (event.type === "toolcall_result_delta") return;
        if (event.type === "toolcall_result_end") {
            const block = this.toolResults.get(event.callId);
            if (block === undefined) throw new Error("Tool-result end arrived without a start.");
            block.content = structuredClone(event.content);
            if (event.isError === true) block.isError = true;
            if (event.incomplete === true) block.incomplete = true;
            this.toolResults.delete(event.callId);
        }
    }

    message(): SessionAssistantMessage | undefined {
        if (this.content.length === 0) return undefined;
        return {
            role: "assistant",
            content: structuredClone(this.content) as SessionAssistantBlock[],
        };
    }

    private clearActiveBlocks(): void {
        this.text = undefined;
        this.reasoning = undefined;
        this.toolCalls.clear();
        this.toolResults.clear();
    }
}

/** Reconstructs one assistant message after consuming a complete run. */
export function assistantMessageFromEvents(
    events: readonly SessionEvent[],
): SessionAssistantMessage | undefined {
    const accumulator = new SessionAssistantMessageAccumulator();
    for (const event of events) accumulator.add(event);
    return accumulator.message();
}
