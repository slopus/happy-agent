import { describe, expect, it, vi } from "vitest";

import type { AppTranscriptEntry } from "./AppTranscriptEntry.js";
import { TranscriptEntryRenderCache } from "./TranscriptEntryRenderCache.js";

describe("TranscriptEntryRenderCache", () => {
    it("reuses stable entry output until render inputs change", () => {
        const cache = new TranscriptEntryRenderCache();
        const entry: AppTranscriptEntry = {
            id: "assistant-1",
            role: "assistant",
            text: "A long historical response.",
        };
        const theme = {};
        const renderEntry = vi.fn(() => ["rendered response"]);

        expect(cache.render(entry, { dynamicState: "", theme, width: 80 }, renderEntry)).toEqual([
            "rendered response",
        ]);
        expect(cache.render(entry, { dynamicState: "", theme, width: 80 }, renderEntry)).toEqual([
            "rendered response",
        ]);
        expect(renderEntry).toHaveBeenCalledOnce();

        entry.text = "Updated response.";
        cache.render(entry, { dynamicState: "", theme, width: 80 }, renderEntry);
        cache.render(entry, { dynamicState: "streaming", theme, width: 80 }, renderEntry);
        cache.render(entry, { dynamicState: "streaming", theme, width: 60 }, renderEntry);

        expect(renderEntry).toHaveBeenCalledTimes(4);
    });

    it("invalidates entries when the theme identity or cache generation changes", () => {
        const cache = new TranscriptEntryRenderCache();
        const entry: AppTranscriptEntry = { id: "tool-1", role: "tool", text: "Read file" };
        const renderEntry = vi.fn(() => ["rendered tool"]);

        cache.render(entry, { dynamicState: "done", theme: {}, width: 80 }, renderEntry);
        cache.render(entry, { dynamicState: "done", theme: {}, width: 80 }, renderEntry);
        cache.clear();
        cache.render(entry, { dynamicState: "done", theme: {}, width: 80 }, renderEntry);

        expect(renderEntry).toHaveBeenCalledTimes(3);
    });
});
