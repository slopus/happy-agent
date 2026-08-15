import { describe, expect, it } from "vitest";

import { validPng32Base64 } from "../../../testing/validImageFixtures.js";
import { IMAGE_PROCESSING_ERROR_PLACEHOLDER } from "../../../images/index.js";
import { prepareProviderMessageImages } from "../prepareProviderMessageImages.js";

describe("prepareProviderMessageImages", () => {
    it("decodes images and corrects a mismatched declared media type", async () => {
        const [message] = await prepareProviderMessageImages([
            {
                role: "user",
                content: [
                    {
                        type: "image",
                        mimeType: "image/jpeg",
                        data: validPng32Base64,
                    },
                ],
                timestamp: 1,
            },
        ]);

        expect(message).toMatchObject({
            role: "user",
            content: [
                {
                    type: "image",
                    mimeType: "image/png",
                    data: validPng32Base64,
                },
            ],
        });
    });

    it("replaces an undecodable tool image without marking the tool call as failed", async () => {
        const [message] = await prepareProviderMessageImages([
            {
                role: "toolResult",
                toolCallId: "call-image",
                toolName: "view_image",
                content: [{ type: "image", mimeType: "image/png", data: "bm90IGFuIGltYWdl" }],
                isError: false,
                timestamp: 1,
            },
        ]);

        expect(message).toEqual({
            role: "toolResult",
            toolCallId: "call-image",
            toolName: "view_image",
            content: [{ type: "text", text: IMAGE_PROCESSING_ERROR_PLACEHOLDER }],
            isError: false,
            timestamp: 1,
        });
    });

    it("reapplies tool-result bounds at the final provider boundary", async () => {
        const [message] = await prepareProviderMessageImages([
            {
                role: "toolResult",
                toolCallId: "call-large",
                toolName: "read_file",
                content: [{ type: "text", text: "x".repeat(100_000) }],
                isError: false,
                timestamp: 1,
            },
        ]);
        const text =
            message?.role === "toolResult"
                ? message.content
                      .filter((content) => content.type === "text")
                      .map((content) => content.text)
                      .join("")
                : "";

        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(50 * 1024);
        expect(text).toContain("Tool result truncated");
    });
});
