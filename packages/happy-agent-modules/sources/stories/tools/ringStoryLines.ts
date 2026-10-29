import type { Story } from "@slopus/happy-agent-client";

/** One line per live story in a ring, as the agent tools describe them. */
export function ringStoryLines(stories: readonly Story[], selfAgentId?: string): string[] {
    return stories.map((story) => {
        const poster = story.author?.kind === "agent" ? story.author.agentId : "someone";
        const by = poster === selfAgentId ? "you" : `agent ${poster}`;
        const caption = story.caption === null ? "no caption" : JSON.stringify(story.caption);
        const minutes = Math.max(0, Math.round((Date.now() - (story.postedAt ?? 0)) / 60_000));
        const age =
            minutes < 60
                ? `${String(minutes)} min ago`
                : minutes < 48 * 60
                  ? `${String(Math.round(minutes / 60))} h ago`
                  : `${String(Math.round(minutes / 1_440))} days ago`;
        const reaction = story.myReaction === null ? "" : `, reacted ${story.myReaction}`;
        return `- ${story.id}: ${caption}, by ${by}, ${age}, ${story.seen ? "seen" : "not seen yet"}${reaction}`;
    });
}
