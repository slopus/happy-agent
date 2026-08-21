import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("file autocomplete filters and navigates without replaying history", () => {
    it("moves the selection, reranks async results, and inserts the chosen path once", async () => {
        const history = Array.from(
            { length: 30 },
            (_, index) => `FILE HISTORY ${String(index).padStart(2, "0")}`,
        ).join("\n");
        const expectedPrompt = "Review @src/features/chat/ChatBeta.tsx";
        const gym = await createGym({
            cols: 68,
            files: {
                "docs/ChatNotes.md": "notes\n",
                "src/features/chat/ChatAlpha.tsx": "export const alpha = true;\n",
                "src/features/chat/ChatBeta.tsx": "export const beta = true;\n",
            },
            inference: [
                { content: [{ text: history, type: "text" }] },
                { content: [{ text: "FILE_MENTION_FILTER_ACCEPTED", type: "text" }] },
            ],
            rows: 12,
        });
        running.add(gym);

        gym.terminal.type("seed file autocomplete history");
        gym.terminal.press("enter");
        const seeded = await gym.terminal.waitUntil(
            (snapshot) => snapshot.text.includes("FILE HISTORY 29") && snapshot.scroll.atBottom,
            "seed transcript at the bottom",
            30_000,
        );
        const baseline = seeded.scroll;

        gym.terminal.type("Review @chat");
        const broadResults = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("ChatAlpha.tsx") &&
                snapshot.text.includes("ChatBeta.tsx") &&
                snapshot.text.includes("ChatNotes.md") &&
                snapshot.scroll.atBottom,
            "broad file autocomplete results",
            30_000,
        );
        const selectedBefore = broadResults.rows.find((row) => row.includes("→"));
        const suggestionsBefore = broadResults.rows.filter(
            (row) =>
                row.includes("ChatAlpha.tsx") ||
                row.includes("ChatBeta.tsx") ||
                row.includes("ChatNotes.md"),
        );
        expect(selectedBefore).toBeDefined();
        expect(suggestionsBefore).toHaveLength(3);
        expect(broadResults.scroll.bottomDepartureCount).toBe(baseline.bottomDepartureCount);
        expect(broadResults.scroll.topArrivalCount).toBe(baseline.topArrivalCount);

        gym.terminal.press("down");
        const navigated = await gym.terminal.waitUntil((snapshot) => {
            const selected = snapshot.rows.find((row) => row.includes("→"));
            return selected !== undefined && selected !== selectedBefore;
        }, "file autocomplete selection to move down");
        expect(navigated.scroll.atBottom).toBe(true);
        expect(navigated.scroll.bottomDepartureCount).toBe(baseline.bottomDepartureCount);
        expect(navigated.scroll.topArrivalCount).toBe(baseline.topArrivalCount);

        gym.terminal.type("b");
        const filtered = await gym.terminal.waitUntil(
            (snapshot) => {
                const suggestions = snapshot.rows.filter(
                    (row) =>
                        row.includes("ChatAlpha.tsx") ||
                        row.includes("ChatBeta.tsx") ||
                        row.includes("ChatNotes.md"),
                );
                return (
                    snapshot.text.includes("› Review @chatb") &&
                    suggestions.length === 3 &&
                    suggestions.join("\n") !== suggestionsBefore.join("\n") &&
                    suggestions[0]?.includes("ChatBeta.tsx") === true &&
                    snapshot.scroll.atBottom
                );
            },
            "async file results reranked for ChatBeta",
            30_000,
        );
        expect(filtered.text).toContain("ChatBeta.tsx");
        expect(filtered.scroll.bottomDepartureCount).toBe(baseline.bottomDepartureCount);
        expect(filtered.scroll.topArrivalCount).toBe(baseline.topArrivalCount);

        gym.terminal.press("up");
        await gym.terminal.waitForText("→ ChatBeta.tsx");
        gym.terminal.press("tab");
        const completedMention = await gym.terminal.waitForText(expectedPrompt, 30_000);
        expect(completedMention.text).not.toContain("ChatAlpha.tsx");
        expect(completedMention.text).not.toContain("ChatNotes.md");
        gym.terminal.press("enter");

        const completed = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("FILE_MENTION_FILTER_ACCEPTED") &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                snapshot.scroll.atBottom,
            "completed file mention turn and idle composer",
            30_000,
        );
        expect(completed.rows).toHaveLength(12);
        expect(completed.scroll.visibleRows).toBe(12);
        expect(completed.scroll.bottomDepartureCount).toBe(baseline.bottomDepartureCount);
        expect(completed.scroll.topArrivalCount).toBe(baseline.topArrivalCount);
        expect(completed.text).toContain("gym off · /workspace");
        expect(completed.text).not.toContain("�");

        const agentRequests = gym.inference.requests.filter(
            (request) => !request.options.sessionId?.endsWith(":title"),
        );
        expect(agentRequests).toHaveLength(2);
        expect(agentRequests[1]?.context.messages.at(-1)).toMatchObject({
            content: [{ text: expectedPrompt, type: "text" }],
            role: "user",
        });

        const scrollbackRows = await collectScrollbackRows(gym);
        expect(countExactRow(scrollbackRows, "› seed file autocomplete history")).toBe(1);
        expect(countExactRow(scrollbackRows, "• FILE HISTORY 00")).toBe(1);
        expect(countExactRow(scrollbackRows, "FILE HISTORY 29")).toBe(1);
        expect(countExactRow(scrollbackRows, `› ${expectedPrompt}`)).toBe(1);

        gym.terminal.scrollToBottom();
        const bottom = await gym.terminal.snapshot();
        expect(bottom.scroll.atBottom).toBe(true);
        expect(bottom.text).toContain("FILE_MENTION_FILTER_ACCEPTED");
        expect(bottom.text).toContain("Ask Happy Terminal to do anything");
        expect(bottom.text).toContain("gym off · /workspace");
    }, 120_000);
});

async function collectScrollbackRows(gym: Gym): Promise<string[]> {
    gym.terminal.scrollToTop();
    let snapshot = await gym.terminal.snapshot();
    const rows: string[] = [];

    for (;;) {
        if (snapshot.scroll.atBottom) {
            rows.push(...snapshot.rows);
            return rows;
        }

        rows.push(snapshot.rows[0] ?? "");
        const previousOffset = snapshot.scroll.offset;
        gym.terminal.scrollBy(1);
        snapshot = await gym.terminal.snapshot();
        if (snapshot.scroll.offset === previousOffset) {
            throw new Error(`Scrollback stopped advancing at offset ${previousOffset}.`);
        }
    }
}

function countExactRow(rows: readonly string[], value: string): number {
    return rows.filter((row) => row.trim() === value).length;
}
