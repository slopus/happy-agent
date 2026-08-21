import { afterEach, describe, expect, it, vi } from "vitest";

import { FileMentionAutocomplete } from "./FileMentionAutocomplete.js";

afterEach(() => {
    vi.useRealTimers();
});

describe("FileMentionAutocomplete", () => {
    it("searches with an empty query and lists files for a bare @", async () => {
        vi.useFakeTimers();
        const searchFiles = vi.fn(async () => [
            { fileName: "mention-target.ts", path: "src/mention-target.ts" },
        ]);
        const autocomplete = new FileMentionAutocomplete(searchFiles, () => undefined);
        const lines = ["@"];
        const cursor = { col: 1, line: 0 };

        autocomplete.sync(lines, cursor);
        await vi.advanceTimersByTimeAsync(80);

        expect(searchFiles).toHaveBeenCalledWith("");
        expect(autocomplete.snapshot(lines, cursor)?.items).toEqual([
            {
                description: "src/mention-target.ts",
                label: "mention-target.ts",
                value: "src/mention-target.ts",
            },
        ]);
    });

    it("does not reopen suggestions after completing a quoted mention", async () => {
        vi.useFakeTimers();
        const searchFiles = vi.fn(async () => [
            { fileName: "alpha beta.ts", path: "src/alpha beta.ts" },
        ]);
        const autocomplete = new FileMentionAutocomplete(searchFiles, () => undefined);
        let lines = ["Please inspect @alpha"];
        let cursor = { col: lines[0]?.length ?? 0, line: 0 };
        autocomplete.sync(lines, cursor);
        await vi.advanceTimersByTimeAsync(80);
        expect(autocomplete.snapshot(lines, cursor)?.items).toHaveLength(1);

        const handled = autocomplete.handleInput("\t", lines, cursor, () => {
            lines = ['Please inspect @"src/alpha beta.ts" '];
            cursor = { col: lines[0]?.length ?? 0, line: 0 };
            autocomplete.dismiss(lines, cursor);
            autocomplete.sync(lines, cursor);
        });
        await vi.advanceTimersByTimeAsync(160);

        expect(handled).toBe(true);
        expect(autocomplete.snapshot(lines, cursor)).toBeUndefined();
        expect(autocomplete.handleInput("\r", lines, cursor, () => undefined)).toBe(false);
        expect(searchFiles).toHaveBeenCalledOnce();
    });
});
