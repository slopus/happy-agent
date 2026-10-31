/**
 * The answer to `read_conversations`: each conversation in the order asked, until the next would
 * pass `limit`. Each one left out keeps its place with a short line, and the answer ends by naming
 * all of them with their headings, since a reminder in the prompt alone was not reliably followed.
 */
export function formatConversationReads(
    reads: readonly { readonly id: string; readonly text: string }[],
    limit: number,
): string {
    const parts: string[] = [];
    const left: string[] = [];
    let size = 0;
    for (const { id, text } of reads) {
        if (size + text.length > limit) {
            parts.push(`${id}: left out to keep this answer short; read it on its own.`);
            left.push(text.split("\n", 1)[0]!.replace(/:$/, ""));
            continue;
        }
        parts.push(text);
        size += text.length;
    }
    if (left.length > 0)
        parts.push(
            `Left out to keep this answer short: ${left.join("; ")}. Read them with read_conversations on their own.`,
        );
    return parts.join("\n\n---\n\n");
}
