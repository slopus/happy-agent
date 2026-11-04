import { describe, expect, it } from "vitest";

import type { ConfigModule } from "../../sources/config/index.js";
import { storyQuoteNotice } from "../../sources/stories/storyQuoteNotice.js";

const config = { chatMediaContentPath: () => "/nonexistent/frame" } as unknown as ConfigModule;
const quote = {
    kind: "story",
    storyId: "s1",
    agentId: "a1",
    userId: null,
    caption: "Ready\nto  try",
    expiresAt: 1,
    frame: { name: "story.png", mimeType: "image/png", size: 10, sha256: "d1" },
};
const accepted = (metadata: Record<string, unknown>) => ({
    type: "message" as const,
    accepted: {
        id: "m1",
        kind: "message",
        message: { role: "user", content: [{ type: "text", text: "Hi" }] },
        metadata,
        profile: null,
    },
});

describe("storyQuoteNotice", () => {
    it("names the story without a frame it cannot read", async () => {
        const notices = await storyQuoteNotice(config, accepted({ quote }) as never);
        expect(notices).toEqual([
            {
                role: "system",
                content: [
                    {
                        type: "text",
                        text: "The person's next message replies to your story “Ready to try” (story s1).",
                    },
                ],
            },
        ]);
    });

    it("says nothing for a message that quotes nothing, or before inference", async () => {
        expect(await storyQuoteNotice(config, accepted({}) as never)).toEqual([]);
        expect(await storyQuoteNotice(config, { type: "inference" } as never)).toEqual([]);
    });
});
