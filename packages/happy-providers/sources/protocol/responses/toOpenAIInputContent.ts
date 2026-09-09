import type {
    ResponseInputImage,
    ResponseInputText,
} from "openai/resources/responses/responses.js";

import type { SessionInputBlock, SessionOutputBlock } from "@/core/SessionContext.js";

export function toOpenAIInputContent(
    content: readonly (SessionInputBlock | SessionOutputBlock)[],
): string | Array<ResponseInputText | ResponseInputImage> {
    if (content.length === 1 && content[0]?.type === "text") return content[0].text;
    return toOpenAIInputContentBlocks(content);
}

/** The same projection without the single-text shorthand, for items that always take blocks. */
export function toOpenAIInputContentBlocks(
    content: readonly (SessionInputBlock | SessionOutputBlock)[],
): Array<ResponseInputText | ResponseInputImage> {
    return content.map((block) => {
        if (block.type === "tool_call_request") {
            throw new Error("Tool requests must be executed by the agent before inference.");
        }
        return block.type === "text"
            ? { type: "input_text", text: block.text }
            : {
                  type: "input_image",
                  detail: "auto",
                  image_url: `data:${block.mimeType};base64,${block.data}`,
              };
    });
}
