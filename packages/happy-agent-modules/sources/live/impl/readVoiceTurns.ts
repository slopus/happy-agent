import type { Context } from "@steve.kite/stdlib";

import type { HistoryModule } from "../../history/index.js";
import { cutWords } from "./renderVoiceCallContext.js";

/** The person's message and one of the agent's, as the phones bound them. */
export const VOICE_USER_BYTES = 2 * 1024;
export const VOICE_REPLY_BYTES = 8 * 1024;

export interface VoiceSaid {
    readonly text: string;
    readonly at: number | undefined;
}

/** One exchange: a message of the person's (or another agent's) and the agent's last words. */
export interface VoiceTurn {
    readonly from: "person" | "agent" | undefined;
    readonly message: VoiceSaid | undefined;
    readonly reply: VoiceSaid | undefined;
}

export interface VoiceTurns {
    /** Oldest first, at most the number asked for. */
    readonly turns: readonly VoiceTurn[];
    readonly older: boolean;
    /** When the person last wrote there and the agent last answered, in what was read. */
    readonly lastPersonAt: number | undefined;
    readonly lastReplyAt: number | undefined;
}

/**
 * A conversation's newest turns from its public history: tool calls, their output, reasoning, and
 * hidden messages never count. Messages are cut after a whole word at the phones' limits.
 */
export async function readVoiceTurns(
    ctx: Context,
    history: HistoryModule,
    agentId: string,
    count: number,
): Promise<VoiceTurns> {
    const page = await history.read(ctx, agentId, {
        from: "end",
        roles: ["user", "assistant", "agent"],
        limit: Math.min(count * 24, 500),
    });
    const turns: { from: VoiceTurn["from"]; message?: VoiceSaid; reply?: VoiceSaid }[] = [];
    let lastPersonAt: number | undefined;
    let lastReplyAt: number | undefined;
    for (const { message } of page.messages) {
        if (message.hideFromUser === true) continue;
        const text = message.blocks
            .flatMap((block) => (block.type === "text" ? [block.text.trim()] : []))
            .filter((part) => part.length > 0)
            .join("\n\n");
        if (text.length === 0) continue;
        if (message.role === "assistant") {
            if (turns.length === 0) turns.push({ from: undefined });
            turns.at(-1)!.reply = { text: cutWords(text, VOICE_REPLY_BYTES), at: message.at };
            lastReplyAt = message.at ?? lastReplyAt;
        } else {
            const from = message.role === "user" ? "person" : "agent";
            turns.push({
                from,
                message: { text: cutWords(text, VOICE_USER_BYTES), at: message.at },
            });
            if (from === "person") lastPersonAt = message.at ?? lastPersonAt;
        }
    }
    return {
        turns: turns.slice(-count).map((turn) => ({
            from: turn.from,
            message: turn.message,
            reply: turn.reply,
        })),
        older: turns.length > count || page.messages.length >= Math.min(count * 24, 500),
        lastPersonAt,
        lastReplyAt,
    };
}
