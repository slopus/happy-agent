import { ExecutorImageGenerationUnavailableError } from "@slopus/rig-execution";
import { describe, expect, it, vi } from "vitest";

import { createJustBashToolHarness } from "../../testing/createAgentTestHarness.js";
import { validPng32Base64 } from "../../testing/validImageFixtures.js";
import { ImageGenerator } from "./ImageGenerator.js";

describe("ImageGenerator", () => {
    it("prefers the current provider and falls back on definitive unavailability", async () => {
        const first = vi
            .fn()
            .mockResolvedValue({ base64: validPng32Base64, mediaType: "image/png" });
        const current = vi
            .fn()
            .mockRejectedValue(new ExecutorImageGenerationUnavailableError("quota exhausted"));
        const generator = new ImageGenerator([
            { id: "first", imageGeneration: { generate: first } },
            { id: "current", imageGeneration: { generate: current } },
        ]);
        const harness = createJustBashToolHarness();

        const result = await generator.generate(
            { prompt: "A lighthouse in a storm" },
            harness.context,
            { preferredProviderId: "current", requestId: "request-1" },
        );

        expect(current).toHaveBeenCalledBefore(first);
        expect(result.path).toBe("/workspace/generated_images/request-1.png");
        expect(result.mediaType).toBe("image/png");
        expect(
            Buffer.from(await harness.context.fs.readFileBuffer(result.path)).toString("base64"),
        ).toBe(validPng32Base64);
    });

    it("round robins providers", async () => {
        const calls: string[] = [];
        const generator = new ImageGenerator(
            ["one", "two"].map((id) => ({
                id,
                imageGeneration: {
                    generate: async () => {
                        calls.push(id);
                        return { base64: validPng32Base64, mediaType: "image/png" as const };
                    },
                },
            })),
        );
        const harness = createJustBashToolHarness();

        await generator.generate({ prompt: "First" }, harness.context, {
            requestId: "first",
        });
        await generator.generate({ prompt: "Second" }, harness.context, {
            requestId: "second",
        });

        expect(calls).toEqual(["one", "two"]);
    });

    it("bounds referenced image reads", async () => {
        const generate = vi
            .fn()
            .mockResolvedValue({ base64: validPng32Base64, mediaType: "image/png" });
        const generator = new ImageGenerator([{ id: "first", imageGeneration: { generate } }]);
        const harness = createJustBashToolHarness({
            files: { "/workspace/reference.png": Buffer.from(validPng32Base64, "base64") },
        });
        const readFileBuffer = vi.spyOn(harness.context.fs, "readFileBuffer");

        await generator.generate(
            { prompt: "Add a red hat", referencedImagePaths: ["reference.png"] },
            harness.context,
            { requestId: "bounded-read" },
        );

        expect(readFileBuffer).toHaveBeenCalledWith("/workspace/reference.png", {
            maxBytes: 32 * 1024 * 1024,
        });
    });

    it.each([
        ["invalid base64", "!!!!", "invalid base64"],
        ["non-PNG data", Buffer.from("not a png").toString("base64"), "not a PNG"],
    ])("rejects %s returned by a provider", async (_name, base64, message) => {
        const generator = new ImageGenerator([
            {
                id: "first",
                imageGeneration: {
                    generate: vi.fn().mockResolvedValue({ base64, mediaType: "image/png" }),
                },
            },
        ]);

        await expect(
            generator.generate({ prompt: "A lighthouse" }, createJustBashToolHarness().context, {
                requestId: "bad-image",
            }),
        ).rejects.toThrow(message);
    });
});
