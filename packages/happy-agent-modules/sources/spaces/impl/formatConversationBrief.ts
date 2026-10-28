/** How much of the agent's last reply a brief quotes: enough to read the person's answer by. */
const AGENT_EXCERPT = 240;
/**
 * How much of the person's own message a brief quotes. Every message they write in any of their
 * conversations is briefed, so each stays a few hundred characters.
 */
const PERSON_EXCERPT = 400;

/**
 * A short notice for Prioritizing about one turn in one of the person's conversations: what the
 * agent last said, and what the person wrote back, or how a session under the row stopped. Bounded
 * one stored brief, so a chatty conversation never crowds out everything else Prioritizing hears.
 * Every brief about one row starts with the same words, so older ones can be replaced.
 */
export function formatConversationBrief(input: {
    readonly rowId: string;
    /** A session under the row, when the turn happened there. */
    readonly sessionId?: string;
    readonly agentText: string | undefined;
    /** What the person wrote; absent when a session stopped without them. */
    readonly personText?: string;
    /** A teammate's name, when someone other than the person wrote it. */
    readonly teammate?: string;
}): string {
    const where =
        input.sessionId === undefined
            ? `row ${input.rowId}`
            : `session ${input.sessionId} under row ${input.rowId}`;
    const agent =
        input.agentText === undefined ? undefined : excerpt(input.agentText, AGENT_EXCERPT);
    if (input.personText === undefined)
        return `${conversationBriefPrefix(input.rowId)}: ${where} stopped. Its last reply: ${agent ?? "(nothing)"}`;
    const writer = input.teammate === undefined ? undefined : excerpt(input.teammate, 64);
    return [
        writer === undefined
            ? `${conversationBriefPrefix(input.rowId)}: the person wrote in ${where}.`
            : `${conversationBriefPrefix(input.rowId)}: their teammate ${writer} wrote in ${where}, not the person.`,
        ...(agent === undefined ? [] : [`Agent before it: ${agent}`]),
        `${writer ?? "Person"}: ${excerpt(input.personText, PERSON_EXCERPT)}`,
    ].join("\n");
}

/** The words every conversation brief about one row starts with. */
export function conversationBriefPrefix(rowId: string): string {
    return `Conversation in ${rowId}`;
}

/** One line of text, cut at `limit` characters with an ellipsis. */
function excerpt(text: string, limit: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > limit ? `${flat.slice(0, limit).trimEnd()}…` : flat;
}
