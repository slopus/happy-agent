/** One message of a conversation as `read_conversations` reads it: text only, oldest first. */
export interface ConversationLine {
    readonly role: "user" | "agent" | "assistant";
    readonly text: string;
    readonly at: number | undefined;
}

/**
 * A conversation's latest turns, oldest first: each message from the person or another agent with
 * the agent's last `replies` text replies that answered it. Messages are cut to `messageLimit`
 * characters, and the oldest turns are left out until the whole fits in `limit`.
 */
export function formatConversationTurns(
    lines: readonly ConversationLine[],
    options: {
        readonly turns: number;
        readonly replies: number;
        readonly now: number;
        readonly messageLimit: number;
        readonly limit: number;
    },
): string {
    const turns: { opener: ConversationLine | undefined; replies: ConversationLine[] }[] = [];
    for (const line of lines) {
        if (line.role === "assistant") {
            if (turns.length === 0) turns.push({ opener: undefined, replies: [] });
            turns.at(-1)!.replies.push(line);
        } else {
            turns.push({ opener: line, replies: [] });
        }
    }
    const say = (line: ConversationLine): string => {
        const who =
            line.role === "user" ? "Person" : line.role === "agent" ? "Another agent" : "Agent";
        const when =
            line.at === undefined ? "" : `, ${formatConversationAge(options.now - line.at)} ago`;
        const text =
            line.text.length > options.messageLimit
                ? `${line.text.slice(0, options.messageLimit)}…`
                : line.text;
        return `${who}${when}: ${text}`;
    };
    const shown = turns
        .slice(-options.turns)
        .map((turn) =>
            [
                ...(turn.opener === undefined ? [] : [turn.opener]),
                ...turn.replies.slice(-options.replies),
            ]
                .map(say)
                .join("\n"),
        );
    let omitted = turns.length - shown.length;
    while (shown.length > 1 && shown.join("\n\n").length > options.limit) {
        shown.shift();
        omitted += 1;
    }
    if (shown.length === 0) return "Nothing has been said here yet.";
    const text = shown.join("\n\n");
    const whole = text.length > options.limit ? `${text.slice(0, options.limit)}…` : text;
    return omitted > 0
        ? `(${String(omitted)} earlier ${omitted === 1 ? "turn" : "turns"} left out)\n${whole}`
        : whole;
}

/** "5 min", "3 h", or "4 days": minutes up to three hours, then hours up to two days. */
export function formatConversationAge(ms: number): string {
    const minutes = Math.max(0, Math.round(ms / 60_000));
    if (minutes < 180) return `${String(minutes)} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${String(hours)} h`;
    return `${String(Math.round(hours / 24))} days`;
}
