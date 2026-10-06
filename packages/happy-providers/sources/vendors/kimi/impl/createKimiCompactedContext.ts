import type { SessionContext, SessionMessage, SessionUserMessage } from "@/core/SessionContext.js";
import { kimiCompactionPrefix } from "../prompts/kimi_compaction_instructions.js";

const CONTINUATION =
    "<system-reminder>\nContext compaction is complete — continue the work that was in progress when it began.\n</system-reminder>";

/** Kimi Code's compactionHandoff.ts: preserve 20k user tokens, keeping 2k at the head. */
export function createKimiCompactedContext(
    context: SessionContext,
    summary: string,
): {
    context: SessionContext;
    preservedMessages: readonly SessionMessage[];
} {
    const users = context.messages.filter(
        (message): message is SessionUserMessage => message.role === "user",
    );
    const total = users.reduce((sum, message) => sum + messageTokens(message), 0);
    const preservedMessages: SessionMessage[] = [];
    if (total <= 20_000) {
        preservedMessages.push(...users);
    } else {
        const tail: SessionUserMessage[] = [];
        let remaining = 18_000;
        let boundary = users.length;
        let droppedPrefix: SessionUserMessage | undefined;
        for (let index = users.length - 1; index >= 0 && remaining > 0; index--) {
            const message = users[index]!;
            const tokens = messageTokens(message);
            boundary = index;
            if (tokens <= remaining) {
                tail.push(message);
                remaining -= tokens;
            } else {
                const text = userText(message);
                const kept = truncate(text, remaining, true);
                tail.push(withText(kept));
                const prefix = text.slice(0, text.length - kept.length);
                if (prefix) droppedPrefix = withText(prefix);
                break;
            }
        }
        tail.reverse();
        const candidates = users.slice(0, boundary);
        if (droppedPrefix !== undefined) candidates.push(droppedPrefix);
        remaining = 2_000;
        for (const message of candidates) {
            if (remaining <= 0) break;
            const tokens = messageTokens(message);
            if (tokens <= remaining) {
                preservedMessages.push(message);
                remaining -= tokens;
            } else {
                preservedMessages.push(withText(truncate(userText(message), remaining, false)));
                break;
            }
        }
        const keptTokens = [...preservedMessages, ...tail].reduce(
            (sum, message) => sum + (message.role === "user" ? messageTokens(message) : 0),
            0,
        );
        preservedMessages.push(
            {
                role: "compaction",
                encryptedContent: null,
                content: `<system-reminder>\nSome of this conversation's user messages were omitted here during compaction: the messages above this note are the oldest user input, the messages below are the most recent, and roughly ${Math.max(0, total - keptTokens)} tokens in between were dropped. The omitted content is covered by the compaction summary at the end of the conversation.\n</system-reminder>`,
            },
            ...tail,
        );
    }
    return {
        preservedMessages,
        context: {
            instructions: context.instructions,
            messages: [
                ...preservedMessages,
                {
                    role: "compaction",
                    content: `${kimiCompactionPrefix.trimEnd()}\n${summary.trim()}`,
                    encryptedContent: null,
                    vendor: { type: "kimi_summary", continuation: CONTINUATION },
                },
            ],
        },
    };
}

function userText(message: SessionUserMessage): string {
    return message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
}

function withText(text: string): SessionUserMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

function messageTokens(message: SessionUserMessage): number {
    return (
        1 +
        message.content.reduce(
            (sum, block) =>
                sum +
                (block.type === "text"
                    ? textTokens(block.text)
                    : block.type === "image"
                      ? 2_000
                      : 0),
            0,
        )
    );
}

function textTokens(text: string): number {
    let ascii = 0;
    let nonAscii = 0;
    for (const character of text) {
        if (character.codePointAt(0)! <= 127) ascii++;
        else nonAscii++;
    }
    return Math.ceil(ascii / 4) + nonAscii;
}

function truncate(text: string, budget: number, fromEnd: boolean): string {
    if (budget <= 0) return "";
    let ascii = 0;
    let nonAscii = 0;
    let units = 0;
    const characters = Array.from(text);
    if (fromEnd) characters.reverse();
    for (const character of characters) {
        if (character.codePointAt(0)! <= 127) ascii++;
        else nonAscii++;
        if (Math.ceil(ascii / 4) + nonAscii > budget) break;
        units += character.length;
    }
    return fromEnd ? text.slice(text.length - units) : text.slice(0, units);
}
