import type { SessionSystemMessage, SessionUserMessage } from "@/core/SessionContext.js";

/**
 * Projects a session system message onto the user role.
 *
 * Anthropic and xAI expose no system or developer role once a conversation is under way, so their
 * native clients deliver out-of-band notices as user turns wrapped in `<system-reminder>`. Folding
 * these into the system prompt instead would lose the position the caller chose and rewrite the
 * cached prefix on every notice.
 */
export function toSessionReminderMessage(message: SessionSystemMessage): SessionUserMessage {
    const text = message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n\n");
    return {
        role: "user",
        content: [
            { type: "text", text: `<system-reminder>\n${text}\n</system-reminder>` },
            // An image cannot be wrapped in the reminder text, so it follows it intact rather
            // than being dropped along with whatever the notice was showing.
            ...message.content.filter((block) => block.type === "image"),
        ],
    };
}
