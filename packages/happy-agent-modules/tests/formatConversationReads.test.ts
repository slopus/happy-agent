import { expect, it } from "vitest";

import { formatConversationReads } from "../sources/live/impl/formatConversationReads.js";

it("names every conversation it left out at the end, so they are read again", () => {
    const read = (id: string, title: string, size: number) => ({
        id,
        text: `Row ${id} ("${title}"), last active 3 days ago:\n${"x".repeat(size)}`,
    });
    const text = formatConversationReads(
        [read("a", "Ship", 40), read("b", "Asset Switching", 40), read("c", "Notes", 5)],
        140,
    );
    expect(text.split("\n\n---\n\n")).toEqual([
        read("a", "Ship", 40).text,
        "b: left out to keep this answer short; read it on its own.",
        read("c", "Notes", 5).text,
        'Left out to keep this answer short: Row b ("Asset Switching"), last active 3 days ago. Read them with read_conversations on their own.',
    ]);
    expect(formatConversationReads([read("a", "Ship", 40)], 100)).toBe(read("a", "Ship", 40).text);
});
