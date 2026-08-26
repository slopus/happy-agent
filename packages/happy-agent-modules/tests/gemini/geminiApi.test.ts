import { describe, expect, it, vi } from "vitest";

import { analyzeGeminiMedia } from "../../sources/gemini/impl/analyzeGeminiMedia.js";
import { generateGeminiImage } from "../../sources/gemini/impl/generateGeminiImage.js";
import { generateGeminiMusic } from "../../sources/gemini/impl/generateGeminiMusic.js";
import { readBoundedResponseText } from "../../sources/gemini/impl/readBoundedResponseText.js";

function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), { status: 200 });
}

function requestInit(request: ReturnType<typeof vi.fn>): RequestInit {
    const init = request.mock.calls[0]?.[1] as RequestInit | undefined;
    if (init === undefined) throw new Error("Gemini was never called.");
    return init;
}

function requestBody(request: ReturnType<typeof vi.fn>): Record<string, unknown> {
    return JSON.parse(String(requestInit(request).body)) as Record<string, unknown>;
}

describe("Gemini media APIs", () => {
    it("generates a configured image through the Interactions API", async () => {
        const request = vi.fn().mockResolvedValue(
            jsonResponse({
                steps: [
                    {
                        type: "model_output",
                        content: [
                            { type: "text", text: "A moonlit harbor." },
                            { type: "image", mime_type: "image/jpeg", data: "AQID" },
                        ],
                    },
                ],
            }),
        );

        const result = await generateGeminiImage({
            apiKey: "secret-key",
            aspectRatio: "16:9",
            fetch: request as unknown as typeof fetch,
            imageSize: "2K",
            mimeType: "image/jpeg",
            prompt: "A moonlit harbor",
        });

        expect(result).toEqual({
            bytes: Buffer.from([1, 2, 3]),
            mimeType: "image/jpeg",
            text: "A moonlit harbor.",
        });
        expect(requestBody(request)).toMatchObject({
            input: [{ type: "text", text: "A moonlit harbor" }],
            model: "gemini-3.1-flash-image",
            response_format: {
                aspect_ratio: "16:9",
                image_size: "2K",
                mime_type: "image/jpeg",
                type: "image",
            },
        });
        // The beta Interactions API is pinned to the revision Rig was written against.
        expect(requestInit(request).headers).toMatchObject({
            "Api-Revision": "2026-05-20",
            "x-goog-api-key": "secret-key",
        });
    });

    it("selects Lyria Clip or Pro and parses MP3 output with lyrics", async () => {
        const request = vi.fn().mockResolvedValue(
            jsonResponse({
                steps: [
                    {
                        type: "model_output",
                        content: [
                            { type: "text", text: "[Verse]\nHello" },
                            { type: "audio", mime_type: "audio/mp3", data: "BAUG" },
                        ],
                    },
                ],
            }),
        );

        const result = await generateGeminiMusic({
            apiKey: "secret-key",
            fetch: request as unknown as typeof fetch,
            mode: "song",
            prompt: "A hopeful synth-pop song",
        });

        expect(result).toEqual({
            bytes: Buffer.from([4, 5, 6]),
            mimeType: "audio/mp3",
            text: "[Verse]\nHello",
        });
        const body = requestBody(request);
        expect(body).toMatchObject({
            input: "A hopeful synth-pop song",
            model: "lyria-3-pro-preview",
        });
        expect(body).not.toHaveProperty("response_format");
    });

    it("analyzes inline media without putting the key in the request body", async () => {
        const request = vi.fn().mockResolvedValue(
            jsonResponse({
                steps: [
                    {
                        type: "model_output",
                        content: [{ type: "text", text: "A short piano recording." }],
                    },
                ],
            }),
        );

        const result = await analyzeGeminiMedia({
            apiKey: "secret-key",
            bytes: new Uint8Array([7, 8, 9]),
            fetch: request as unknown as typeof fetch,
            mimeType: "audio/mp3",
            prompt: "Describe this recording",
            type: "audio",
        });

        expect(result).toBe("A short piano recording.");
        const body = requestBody(request);
        expect(body).toMatchObject({
            input: [
                { data: "BwgJ", mime_type: "audio/mp3", type: "audio" },
                { text: "Describe this recording", type: "text" },
            ],
            model: "gemini-3.5-flash",
        });
        expect(JSON.stringify(body)).not.toContain("secret-key");
    });

    it("reports what Gemini said went wrong, with the status it said it under", async () => {
        const request = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ error: { message: "Quota exceeded." } }), {
                status: 429,
            }),
        );

        await expect(
            generateGeminiImage({
                apiKey: "secret-key",
                fetch: request as unknown as typeof fetch,
                prompt: "A moonlit harbor",
            }),
        ).rejects.toThrow("Gemini image generation failed (429): Quota exceeded.");
    });

    it("reports an answer that is not JSON at all rather than parsing nothing", async () => {
        const request = vi
            .fn()
            .mockResolvedValue(new Response("<html>gateway timeout</html>", { status: 504 }));

        await expect(
            analyzeGeminiMedia({
                apiKey: "secret-key",
                bytes: new Uint8Array([7]),
                fetch: request as unknown as typeof fetch,
                mimeType: "audio/mp3",
                prompt: "Describe this recording",
                type: "audio",
            }),
        ).rejects.toThrow("Gemini media analysis returned invalid JSON (504).");
    });

    it("refuses a response that declares more bytes than the operation allows", async () => {
        const request = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ steps: [] }), {
                headers: { "content-length": String(64 * 1024 * 1024 + 1) },
                status: 200,
            }),
        );

        await expect(
            generateGeminiImage({
                apiKey: "secret-key",
                fetch: request as unknown as typeof fetch,
                prompt: "A moonlit harbor",
            }),
        ).rejects.toThrow("Gemini response exceeded the 67108864 byte size limit.");
    });

    it("stops reading a body that grows past the limit while it arrives", async () => {
        const chunks = ["12345", "67890"];
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
                controller.close();
            },
        });

        await expect(readBoundedResponseText(new Response(body), 6)).rejects.toThrow(
            "Gemini response exceeded the 6 byte size limit.",
        );
    });

    it("reads a body that stays within the limit", async () => {
        expect(await readBoundedResponseText(new Response("hello"), 16)).toBe("hello");
    });
});
