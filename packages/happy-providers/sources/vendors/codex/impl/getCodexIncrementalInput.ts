import { codexValuesEqual } from "@/vendors/codex/impl/codexValuesEqual.js";
import { codexRequestPropertiesMatch } from "@/vendors/codex/impl/codexRequestPropertiesMatch.js";
import type {
    ResponseInputItem,
    ResponseOutputItem,
} from "openai/resources/responses/responses.js";
import type { CodexResponseRequest } from "@/vendors/codex/impl/CodexResponseRequest.js";

/** Returns the wire-input suffix reusable with the last response ID, or undefined. */
export function getCodexIncrementalInput(
    previousRequest: CodexResponseRequest,
    outputItems: readonly ResponseOutputItem[],
    currentRequest: CodexResponseRequest,
): ResponseInputItem[] | undefined;
export function getCodexIncrementalInput(
    previousRequest: object,
    outputItems: readonly unknown[],
    currentRequest: object,
): unknown[] | undefined;
export function getCodexIncrementalInput(
    previousRequest: object,
    outputItems: readonly unknown[],
    currentRequest: object,
): unknown[] | undefined {
    if (!codexRequestPropertiesMatch(previousRequest, currentRequest)) return undefined;
    const previousValue = Reflect.get(previousRequest, "input");
    const currentValue = Reflect.get(currentRequest, "input");
    const previousInput = Array.isArray(previousValue) ? previousValue : [];
    const currentInput = Array.isArray(currentValue) ? currentValue : [];
    const reusableOutputItems = outputItems.filter(isResponseInputItem);
    if (reusableOutputItems.length !== outputItems.length) return undefined;
    const expectedPrefix = [...previousInput, ...reusableOutputItems].map(clearIgnoredMetadata);
    if (currentInput.length < expectedPrefix.length) return undefined;
    const actualPrefix = currentInput.slice(0, expectedPrefix.length).map(clearIgnoredMetadata);
    if (!codexValuesEqual(expectedPrefix, actualPrefix)) return undefined;
    return currentInput.slice(expectedPrefix.length);
}

const RESPONSE_INPUT_ITEM_TYPES = new Set([
    "apply_patch_call",
    "apply_patch_call_output",
    "code_interpreter_call",
    "compaction",
    "compaction_trigger",
    "computer_call",
    "computer_call_output",
    "custom_tool_call",
    "custom_tool_call_output",
    "file_search_call",
    "function_call",
    "function_call_output",
    "image_generation_call",
    "item_reference",
    "local_shell_call",
    "local_shell_call_output",
    "mcp_approval_request",
    "mcp_approval_response",
    "mcp_call",
    "mcp_list_tools",
    "message",
    "program",
    "program_output",
    "reasoning",
    "shell_call",
    "shell_call_output",
    "tool_search_call",
    "tool_search_output",
    "web_search_call",
]);

function isResponseInputItem(value: unknown): value is ResponseInputItem {
    if (typeof value !== "object" || value === null || !("type" in value)) return false;
    return typeof value.type === "string" && RESPONSE_INPUT_ITEM_TYPES.has(value.type);
}

function clearIgnoredMetadata(value: unknown): unknown {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const copy = structuredClone(value) as Record<string, unknown>;
    delete copy.internal_chat_message_metadata_passthrough;
    // The service stamps its own turn metadata on every output item. Codex's typed response item
    // has no such field and drops it on receipt, so it never takes part in Codex's comparison.
    delete copy.metadata;
    // Public assistant blocks intentionally omit provider-generated output-item identities.
    // The stateful session still has the original items, so compare their caller-visible
    // semantics and keep stable call_id values as the continuation identity.
    delete copy.id;
    if (
        copy.type === "message" ||
        copy.type === "function_call" ||
        copy.type === "custom_tool_call"
    ) {
        delete copy.status;
    }
    if (copy.type === "message") {
        delete copy.phase;
        // Public text blocks keep only the text, so their replay carries no `logprobs`. The
        // service reports an empty list when none were requested; that empty list says nothing
        // the replay lacks, while real log probabilities still force a full request.
        if (Array.isArray(copy.content)) copy.content = copy.content.map(clearEmptyLogprobs);
    }
    return copy;
}

function clearEmptyLogprobs(part: unknown): unknown {
    if (typeof part !== "object" || part === null || Array.isArray(part)) return part;
    if (!("logprobs" in part) || !Array.isArray(part.logprobs) || part.logprobs.length > 0)
        return part;
    const { logprobs: _logprobs, ...rest } = part;
    return rest;
}
