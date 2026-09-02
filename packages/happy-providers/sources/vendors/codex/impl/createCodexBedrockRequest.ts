import type {
    EasyInputMessage,
    ResponseInputItem,
    ResponseInputMessageContentList,
} from "openai/resources/responses/responses.js";

import type { CodexResponseRequest } from "@/vendors/codex/impl/CodexResponseRequest.js";
import { responseInputItems } from "@/protocol/responses/responseInputItems.js";

export function createCodexBedrockRequest(request: CodexResponseRequest): CodexResponseRequest {
    const output: CodexResponseRequest = structuredClone(request);
    // The Codex Bedrock route uses its implicit/default tier, so no Codex service tier is sent.
    delete output.service_tier;
    const normalizedInput = responseInputItems(output.input).map((item): ResponseInputItem => {
        if (!isStringInputMessage(item)) return item;
        return {
            ...item,
            content: [{ type: "input_text", text: item.content }],
        };
    });
    output.input = normalizedInput.reduce<ResponseInputItem[]>((items, item) => {
        const previous = items.at(-1);
        if (isDeveloperContentMessage(previous) && isDeveloperContentMessage(item)) {
            previous.content.push(...item.content);
        } else {
            items.push(item);
        }
        return items;
    }, []);
    return output;
}

function isDeveloperContentMessage(
    item: ResponseInputItem | undefined,
): item is EasyInputMessage & { content: ResponseInputMessageContentList } {
    return (
        item !== undefined &&
        "role" in item &&
        "content" in item &&
        item.role === "developer" &&
        Array.isArray(item.content)
    );
}

function isStringInputMessage(
    item: ResponseInputItem,
): item is EasyInputMessage & { content: string } {
    return "role" in item && "content" in item && typeof item.content === "string";
}
