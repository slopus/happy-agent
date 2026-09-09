import type { SessionContext, SessionInputBlock } from "@/core/SessionContext.js";

export function stripGrokContextImages(context: SessionContext): SessionContext | undefined {
    let removed = false;
    const keepBlock = (block: SessionInputBlock): boolean => {
        if (block.type !== "image") return true;
        removed = true;
        return false;
    };
    const messages = context.messages.map((message) => {
        if (message.role === "user") {
            return { ...message, content: message.content.filter(keepBlock) };
        }
        if (message.role === "tool") {
            return { ...message, content: message.content.filter(keepBlock) };
        }
        return message;
    });
    return removed ? { ...context, messages } : undefined;
}
