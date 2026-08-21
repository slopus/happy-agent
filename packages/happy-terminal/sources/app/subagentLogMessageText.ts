import type { Message } from "../protocol/index.js";

export function subagentLogMessageText(message: Message): string {
    return message.blocks
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n")
        .trim();
}
