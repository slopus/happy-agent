import type { AgentSystemRef } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { EventsModule } from "../../events/index.js";
import type { HistoryModule } from "../../history/index.js";
import type { TeamModule } from "../../team/index.js";
import { formatConversationTurns } from "./formatConversationTurns.js";
import type { VoiceOutline } from "./VoiceOutline.js";

/** One conversation's share of a `read_conversations` answer. */
export const VOICE_CONVERSATION_TEXT_LIMIT = 4_000;
const VOICE_CONVERSATION_MESSAGE_LIMIT = 1_200;

/**
 * One conversation as Voice reads it: its title, whether it is running, and its latest turns,
 * each the person's or another agent's message with the agent's last replies to it. Tool calls,
 * their output, reasoning, and hidden messages are left out. On a standalone machine Voice may read
 * any live conversation; with a team, "this machine" holds other members' conversations, so only
 * a conversation in the person's sidebar, or a session under one, is read.
 */
export async function readVoiceConversation(
    ctx: Context,
    modules: {
        readonly agents: AgentSystemRef;
        readonly history: HistoryModule;
        readonly events: EventsModule;
        readonly team: TeamModule;
    },
    outline: VoiceOutline,
    agentId: string,
    input: { readonly turns: number; readonly replies: number },
): Promise<string> {
    const { agents } = modules;
    const config = await agents.config(ctx, agentId);
    const visible =
        config !== undefined &&
        typeof config.metadata?.["archivedAt"] !== "number" &&
        (!modules.team.enabled || (await inSidebar(ctx, agents, outline, agentId)));
    if (!visible) return `${agentId} is not a conversation the person can see on this machine.`;
    const title = config.metadata?.["title"];
    const now = Date.now();
    const heading = `Conversation ${agentId}${typeof title === "string" ? ` ("${title}")` : ""}${modules.events.activeRunId(agentId) === undefined ? "" : ", running now"}:`;
    const page = await modules.history.read(ctx, agentId, {
        from: "end",
        roles: ["user", "assistant", "agent"],
        limit: Math.min(input.turns * 24, 500),
    });
    const lines = page.messages.flatMap(({ message }) => {
        if (message.hideFromUser === true) return [];
        const text = message.blocks
            .flatMap((block) => (block.type === "text" ? [block.text.trim()] : []))
            .filter((part) => part.length > 0)
            .join("\n\n");
        if (text.length === 0) return [];
        const role =
            message.role === "user" ? "user" : message.role === "agent" ? "agent" : "assistant";
        return [{ role, text, at: message.at } as const];
    });
    return `${heading}\n${formatConversationTurns(lines, {
        turns: input.turns,
        replies: input.replies,
        now,
        messageLimit: VOICE_CONVERSATION_MESSAGE_LIMIT,
        limit: VOICE_CONVERSATION_TEXT_LIMIT,
    })}`;
}

/** Whether the conversation, or the root conversation it is a session of, is a sidebar row. */
async function inSidebar(
    ctx: Context,
    agents: AgentSystemRef,
    outline: VoiceOutline,
    agentId: string,
): Promise<boolean> {
    const rows = new Set(
        outline.rows.flatMap((row) => (row.agentId === undefined ? [] : [row.agentId])),
    );
    let current = agentId;
    for (let depth = 0; depth < 16; depth++) {
        if (rows.has(current)) return true;
        const parent = await agents.parentOf(ctx, current);
        if (parent === null) return false;
        current = parent;
    }
    return false;
}
