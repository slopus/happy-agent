import { describe, expect, it } from "vitest";

import type { HistoryModule } from "../sources/history/index.js";
import { readVoiceTurns } from "../sources/live/impl/readVoiceTurns.js";
import {
    cutBytes,
    cutWords,
    renderVoiceCallContext,
} from "../sources/live/impl/renderVoiceCallContext.js";
import type { VoiceDirectoryRow } from "../sources/live/impl/readVoiceDirectory.js";
import { voiceDirectoryUpdate } from "../sources/live/impl/voiceDirectoryUpdate.js";
import { keyBetween, VoiceRefs } from "../sources/live/impl/VoiceRefs.js";
import { voiceAgo, voiceClock } from "../sources/live/impl/voiceTimes.js";

const row = (agentId: string, title: string, parents: string[] = []): VoiceDirectoryRow => ({
    agentId,
    title,
    kind: parents.length === 0 ? "task" : "subtask",
    parents,
});

describe("conversation references", () => {
    it("gives the first directory the shortest keys, never ending in 0", () => {
        const nine = VoiceRefs.start(Array.from({ length: 9 }, (_, index) => `a${String(index)}`));
        expect([nine.ref("a0"), nine.ref("a8")]).toEqual(["s1", "s9"]);
        const ten = VoiceRefs.start(Array.from({ length: 10 }, (_, index) => `a${String(index)}`));
        expect(Array.from({ length: 10 }, (_, index) => ten.ref(`a${String(index)}`))).toEqual([
            "s11",
            "s12",
            "s13",
            "s14",
            "s15",
            "s16",
            "s17",
            "s18",
            "s19",
            "s21",
        ]);
    });

    it("places later arrivals between their neighbours as the phones do", () => {
        expect(keyBetween("4", "5")).toBe("49");
        expect(keyBetween("4", "49")).toBe("48");
        expect(keyBetween("4", "41")).toBe("409");
        expect(keyBetween("9", undefined)).toBe("91");
        expect(keyBetween(undefined, "1")).toBe("09");
        const refs = VoiceRefs.start(["a", "b"]);
        expect(refs.place(["new-first", "a", "between", "b", "last"])).toEqual([
            "new-first",
            "between",
            "last",
        ]);
        expect(["new-first", "a", "between", "b", "last"].map((id) => refs.ref(id))).toEqual([
            "s09",
            "s1",
            "s19",
            "s2",
            "s3",
        ]);
        // A reference is never handed to another conversation, even after its own went away.
        expect(refs.place(["a", "again", "b"])).toEqual(["again"]);
        expect(refs.ref("again")).toBe("s18");
        expect(refs.ref("between")).toBe("s19");
    });
});

describe("directory updates", () => {
    it("tells additions, removals, renames, and only the conversations that moved", () => {
        const told = [
            row("a", "Architect"),
            row("b", "Release"),
            row("c", "Cache"),
            row("d", "Docs"),
        ];
        const refs = VoiceRefs.start(told.map((item) => item.agentId));
        expect(voiceDirectoryUpdate(told, told, refs)).toBeUndefined();
        const current = [
            row("a", "Architect"),
            row("c", "Cache race"),
            row("b", "Release"),
            row("e", "Benchmark", ["Release"]),
        ];
        refs.place(current.map((item) => item.agentId));
        expect(JSON.parse(voiceDirectoryUpdate(told, current, refs)!)).toEqual({
            added: [
                {
                    kind: "subtask",
                    parents: ["Release"],
                    ref: "s5",
                    title: "Benchmark",
                },
            ],
            event: "directory",
            moved: [{ after: "s3", ref: "s2" }],
            removed: ["s4"],
            renamed: [{ ref: "s3", title: "Cache race" }],
        });
    });

    it("says where an addition sits when its reference does not sort into place", () => {
        const told = [row("a", "A"), row("b", "B")];
        const refs = VoiceRefs.start(["a", "b"]);
        // A conversation the call referenced before the sidebar placed it, now listed first.
        refs.place(["a", "b", "late"]);
        const current = [row("late", "Late"), row("a", "A"), row("b", "B")];
        expect(JSON.parse(voiceDirectoryUpdate(told, current, refs)!).added).toEqual([
            { after: null, kind: "task", ref: "s3", title: "Late" },
        ]);
    });

    it("tells at most twenty changes within four kilobytes and counts the rest", () => {
        const current = Array.from({ length: 30 }, (_, index) =>
            row(`n${String(index)}`, `Task ${String(index)}`),
        );
        const refs = VoiceRefs.start([]);
        refs.place(current.map((item) => item.agentId));
        const update = JSON.parse(voiceDirectoryUpdate([], current, refs)!);
        expect(update.added).toHaveLength(20);
        expect(update.more).toBe(10);
    });
});

describe("times and cuts", () => {
    it("says times aloud and gives the exact minute on the person's clock", () => {
        expect(
            [0, 60_000, 5 * 60_000, 3_600_000, 5 * 3_600_000, 86_400_000, 3 * 86_400_000].map(
                voiceAgo,
            ),
        ).toEqual([
            "just now",
            "a minute ago",
            "5 minutes ago",
            "an hour ago",
            "5 hours ago",
            "yesterday",
            "3 days ago",
        ]);
        const at = Date.UTC(2026, 10, 6, 8, 15, 42);
        expect(voiceClock(at, "Europe/Berlin")).toBe("2026-11-06T09:15+01:00");
        expect(voiceClock(at, "America/Los_Angeles")).toBe("2026-11-06T00:15-08:00");
        expect(voiceClock(at, "Not/AZone")).toBe("2026-11-06T08:15+00:00");
    });

    it("cuts long text after a whole word and says how much was left out", () => {
        expect(cutWords("short", 100)).toBe("short");
        const cut = cutWords("word ".repeat(100), 100);
        expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(100);
        expect(cut).toMatch(/^(word )+word … \(cut, \d+ more words\)$/);
    });

    it("never cuts a character in half, however small the budget", () => {
        const emoji = "😀".repeat(50);
        for (const bytes of [0, 5, 31, 32, 33, 99, 101]) {
            for (const cut of [cutBytes(emoji, bytes), cutWords(emoji, bytes)]) {
                expect(cut).not.toContain("\uFFFD");
                expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(Math.max(bytes, 3));
            }
        }
        expect(cutBytes("aé", 2)).toBe("a");
        expect(cutWords("ééééé ".repeat(20), 64)).toMatch(
            /^(ééééé )*ééééé … \(cut, \d+ more words\)$/,
        );
    });
});

describe("the first context", () => {
    it("gives way in a large sidebar without rendering it over and over", () => {
        const rows = Array.from({ length: 600 }, (_, index) => ({
            row: {
                agentId: `a${String(index)}`,
                title: `Gym performance session ${String(index)}`,
                kind: "conversation" as const,
                parents: [`gym-project-${String(Math.floor(index / 33))}`],
                headings: [
                    {
                        title: `gym-project-${String(Math.floor(index / 33))}`,
                        kind: "project" as const,
                    },
                ],
            },
            ref: `s${String(index + 11)}`,
            state: { working: false, needsPerson: false, lastActivityAt: 0 },
            rank: index,
        }));
        const recap = Array.from({ length: 30 }, (_, index) => ({
            at: index,
            kind: "person" as const,
            text: "r".repeat(900),
        }));
        const started = performance.now();
        const { text, listed } = renderVoiceCallContext({
            now: 3_600_000,
            timeZone: "UTC",
            focusRevision: 1,
            recap,
            onScreen: undefined,
            rows,
            bytes: 16 * 1024,
        });
        // A 524-conversation remote once spent 300 ms here, and this shape 17 seconds.
        expect(performance.now() - started).toBeLessThan(2000);
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16 * 1024);
        expect(listed.length).toBeGreaterThan(0);
        expect(listed.length).toBeLessThanOrEqual(100);
    });

    it("lets the recap's older lines give way after the directory, keeping its newest", () => {
        const recap = Array.from({ length: 30 }, (_, index) => ({
            at: index,
            kind: "person" as const,
            text: `Recap ${String(index)} ${"r".repeat(900)}`,
        }));
        const context = renderVoiceCallContext({
            now: 60_000,
            timeZone: "UTC",
            focusRevision: 0,
            recap,
            onScreen: undefined,
            rows: Array.from({ length: 100 }, (_, index) => ({
                row: row(`r${String(index)}`, `Conversation ${String(index)} ${"y".repeat(80)}`),
                ref: `s${String(index + 101)}`,
                state: undefined,
                rank: index,
            })),
            bytes: 12 * 1024,
        }).text;
        expect(Buffer.byteLength(context)).toBeLessThanOrEqual(12 * 1024);
        expect(context).toContain("Recap 29");
        expect(context).not.toContain("Recap 0 ");
        expect(context).toContain("Older lines aren't shown.");
        expect(context).toContain("more not listed");
    });

    it("leaves voice's own stored words out of the recap", () => {
        const { text } = renderVoiceCallContext({
            now: 60_000,
            timeZone: "UTC",
            focusRevision: 0,
            recap: [
                { at: 0, kind: "person", text: "Open it." },
                { at: 0, kind: "assistant", text: "Okay, opening it. That's open." },
                { at: 0, kind: "outcome", text: "Opened Lighthouse Ledger." },
            ],
            onScreen: undefined,
            rows: [],
        });
        expect(text).toContain(
            "- a minute ago, the person: Open it.\n- a minute ago, your backend reported: Opened Lighthouse Ledger.",
        );
        expect(text).not.toContain("That's open.");
    });

    it("keeps the on-screen and recently active conversations over the sidebar's tail", () => {
        const rows = Array.from({ length: 150 }, (_, index) => ({
            row: row(`r${String(index)}`, `Conversation ${String(index)}`),
            ref: `s${String(index + 101)}`,
            state: undefined,
            // Conversation 140 is on screen; the rest rank by sidebar order here.
            rank: index === 140 ? 0 : index + 1,
        }));
        const context = renderVoiceCallContext({
            now: 0,
            timeZone: "UTC",
            focusRevision: 0,
            recap: [],
            onScreen: undefined,
            rows,
        }).text;
        expect(context).toContain("- Conversation 140 — task");
        expect(context).toContain("- Conversation 0 — task");
        expect(context).not.toContain("- Conversation 99 — task");
        expect(context).toContain("… and 50 more not listed;");
    });

    it("lets older turns, then the directory's tail, give way before the newest turn", () => {
        const long = "x ".repeat(3_000);
        const context = renderVoiceCallContext({
            now: Date.UTC(2026, 10, 6, 8, 15),
            timeZone: "UTC",
            focusRevision: 0,
            recap: [],
            onScreen: {
                row: row("a", "Architect"),
                ref: "s1",
                state: { working: true, needsPerson: false, lastActivityAt: undefined },
                turns: {
                    turns: Array.from({ length: 5 }, (_, index) => ({
                        from: "person" as const,
                        message: { text: `Question ${String(index)} ${long}`, at: undefined },
                        reply: { text: `Answer ${String(index)} ${long}`, at: undefined },
                    })),
                    older: false,
                    lastPersonAt: undefined,
                    lastReplyAt: undefined,
                },
            },
            rows: Array.from({ length: 100 }, (_, index) => ({
                row: row(`r${String(index)}`, `Conversation ${String(index)} ${"y".repeat(80)}`),
                ref: `s${String(index + 11)}`,
                state: undefined,
                rank: index,
            })),
        }).text;
        expect(Buffer.byteLength(context)).toBeLessThanOrEqual(24 * 1024);
        expect(context).toContain("Question 4");
        expect(context).not.toContain("Question 0");
        expect(context).toContain("Older turns aren't shown.");
        expect(context).toContain("Conversation 0 ");
    });
});

describe("turns, as the phones bound them", () => {
    it("reads the five newest turns, cutting the person's at 2 KiB and the agent's at 8 KiB", async () => {
        const messages = Array.from({ length: 7 }, (_, index) => [
            { role: "user", text: `Question ${String(index)} ${"q ".repeat(2_000)}`, at: index },
            { role: "assistant", text: `Answer ${String(index)} ${"a ".repeat(8_000)}`, at: index },
        ]).flat();
        const history = {
            read: async (_ctx: unknown, _agentId: string, query: { limit: number }) => ({
                messages: messages.slice(-query.limit).map((message) => ({
                    message: { ...message, blocks: [{ type: "text", text: message.text }] },
                })),
            }),
        } as unknown as HistoryModule;
        const read = await readVoiceTurns({} as never, history, "agent", 5);
        expect(read.turns).toHaveLength(5);
        expect(read.older).toBe(true);
        expect(read.turns[0]!.message!.text.startsWith("Question 2")).toBe(true);
        for (const turn of read.turns) {
            expect(Buffer.byteLength(turn.message!.text)).toBeLessThanOrEqual(2 * 1024);
            expect(Buffer.byteLength(turn.reply!.text)).toBeLessThanOrEqual(8 * 1024);
            expect(turn.reply!.text).toMatch(/… \(cut, \d+ more words\)$/u);
        }
    });
});
