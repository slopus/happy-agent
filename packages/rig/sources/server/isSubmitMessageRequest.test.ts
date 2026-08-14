import { describe, expect, it } from "vitest";

import { isSubmitMessageRequest } from "./isSubmitMessageRequest.js";

describe("isSubmitMessageRequest", () => {
    it("accepts text and image blocks without flattening their structure", () => {
        expect(
            isSubmitMessageRequest({
                content: [
                    { text: "look at this", type: "text" },
                    {
                        data: "aGVsbG8=",
                        detail: "original",
                        mediaType: "image/png",
                        type: "image",
                    },
                ],
                text: "look at this",
            }),
        ).toBe(true);
    });

    it("rejects unsupported or malformed content blocks", () => {
        expect(
            isSubmitMessageRequest({
                content: [{ data: "raw", mediaType: "audio/wav", type: "audio" }],
                text: "unsupported",
            }),
        ).toBe(false);
        expect(
            isSubmitMessageRequest({
                content: [{ data: "raw", mediaType: "image/png", type: "image", unknown: true }],
                text: "malformed",
            }),
        ).toBe(false);
    });
});
