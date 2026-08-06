import { describe, expect, it } from "vitest";

import { mapOpenAIResponseStream } from "@/protocol/responses/mapOpenAIResponseStream.js";
import { createHostedCitationFilter } from "@/protocol/responses/stripHostedCitationMarkers.js";
import type { SessionEvent } from "@/core/SessionEvent.js";

/**
 * The exact text a live `gpt-5.6-sol` turn produced with hosted web search on, markers and all.
 * OpenAI resolves some citations into ordinary links and leaves others as references into search
 * results Rig never receives.
 */
const LIVE_ANSWER =
    "Latest Deno version: **2.8.1**. \u{e200}cite\u{e202}turn0search0\u{e201}2. Latest Bun " +
    "version: **1.3.14**. \u{e200}cite\u{e202}turn1search0\u{e201}3. Go: **1.26.5**. " +
    "\u{e200}cite\u{e202}turn5view0\u{e201}Deno: **2.9.4** ([github.com](https://github.com/x))";

describe("hosted search citation markers", () => {
    it("keeps the prose and the links, and drops what cannot be resolved", () => {
        const filter = createHostedCitationFilter();

        const text = filter(LIVE_ANSWER);

        expect(text).toBe(
            "Latest Deno version: **2.8.1**. 2. Latest Bun version: **1.3.14**. 3. Go: " +
                "**1.26.5**. Deno: **2.9.4** ([github.com](https://github.com/x))",
        );
        expect(text).not.toMatch(/[\u{e000}-\u{f8ff}]/u);
    });

    // The answer arrives as stream deltas chosen by the network, not by the marker. One split
    // through the middle would otherwise leave both halves on screen, since neither half contains
    // anything a per-delta match could recognise.
    it("removes a marker split across deltas", async () => {
        const filter = createHostedCitationFilter();
        const pieces = ["Deno is **2.8.1**. \u{e200}cit", "e\u{e202}turn0sea", "rch0\u{e201}Next."];

        expect(pieces.map((piece) => filter(piece)).join("")).toBe("Deno is **2.8.1**. Next.");
    });

    it("strips them from the text a real response stream yields", async () => {
        const events = [
            {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "message", id: "m1" },
            },
            {
                type: "response.output_text.delta",
                output_index: 0,
                delta: "Deno is **2.8.1**. \u{e200}cite\u{e202}turn0search0\u{e201}Done.",
            },
            {
                type: "response.completed",
                response: { output: [], usage: { total_tokens: 1 } },
            },
        ];
        const mapped = mapOpenAIResponseStream(stream(events), {
            failureMessage: "unused",
            hostedToolNames: new Set(["web_search"]),
            vendor: "codex",
        });
        const collected: SessionEvent[] = [];
        let next = await mapped.next();
        while (next.done !== true) {
            collected.push(next.value);
            next = await mapped.next();
        }

        const deltas = collected.flatMap((event) =>
            event.type === "text_delta" ? [event.delta] : [],
        );
        expect(deltas.join("")).toBe("Deno is **2.8.1**. Done.");
    });
});

async function* stream(events: readonly unknown[]) {
    for (const event of events) yield event as never;
}
