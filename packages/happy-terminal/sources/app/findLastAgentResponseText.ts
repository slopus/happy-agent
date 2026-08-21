import type { Message } from "../protocol/index.js";

export function findLastAgentResponseText(messages: readonly Message[]): string | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== "agent") continue;
        const text = message.blocks
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n")
            .trim();
        if (text.length > 0) return text;
    }
    return undefined;
}
