import { describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { ExecutorImageGenerationUnavailableError } from "@slopus/rig-execution";

import { createJustBashToolHarness } from "../testing/createJustBashToolHarness.js";
import { validPng32Base64 } from "../testing/validImageFixtures.js";
import { createImageGenerationTool } from "./createImageGenerationTool.js";
import { codexImageGenerationSurface, imageGenerationSurface } from "./imageGenerationSurfaces.js";

describe("createImageGenerationTool", () => {
    it("prefers the current Codex provider and falls back to the first working account", async () => {
        const first = vi
            .fn()
            .mockResolvedValue({ base64: validPng32Base64, mediaType: "image/png" });
        const current = vi
            .fn()
            .mockRejectedValue(new ExecutorImageGenerationUnavailableError("quota exhausted"));
        const tool = createImageGenerationTool(
            [
                { id: "first", imageGeneration: { generate: first } },
                { id: "current", imageGeneration: { generate: current } },
            ],
            imageGenerationSurface,
        );
        const harness = createJustBashToolHarness();

        const result = await tool.execute({ prompt: "A lighthouse in a storm" }, harness.context, {
            ctx: harness.ctx,
            provider: { id: "current" } as never,
            toolCallId: "call-1",
        });

        expect(current).toHaveBeenCalledBefore(first);
        expect(result).toMatchObject({
            path: "/workspace/generated_images/call-1.png",
        });
        expect(
            Buffer.from(await harness.context.fs.readFileBuffer(result.path)).toString("base64"),
        ).toBe(validPng32Base64);
        expect(current.mock.calls[0]?.[0].turnId).toBe("call-1");
        expect(first.mock.calls[0]?.[0].turnId).toBe("call-1");
    });

    it("round robins the first candidate when the current provider cannot generate images", async () => {
        const calls: string[] = [];
        const tool = createImageGenerationTool(
            ["one", "two"].map((id) => ({
                id,
                imageGeneration: {
                    generate: async () => {
                        calls.push(id);
                        return { base64: validPng32Base64, mediaType: "image/png" as const };
                    },
                },
            })),
            imageGenerationSurface,
        );
        const harness = createJustBashToolHarness();

        await tool.execute({ prompt: "First" }, harness.context, {
            ctx: harness.ctx,
            toolCallId: "first",
        });
        await tool.execute({ prompt: "Second" }, harness.context, {
            ctx: harness.ctx,
            toolCallId: "second",
        });

        expect(calls).toEqual(["one", "two"]);
    });

    it("does not generate again when persistence fails after provider success", async () => {
        const first = vi
            .fn()
            .mockResolvedValue({ base64: validPng32Base64, mediaType: "image/png" });
        const second = vi.fn();
        const tool = createImageGenerationTool(
            [
                { id: "first", imageGeneration: { generate: first } },
                { id: "second", imageGeneration: { generate: second } },
            ],
            imageGenerationSurface,
        );
        const harness = createJustBashToolHarness({
            files: { "/workspace/generated_images/call-1.png": "existing" },
        });

        await expect(
            tool.execute({ prompt: "A lighthouse in a storm" }, harness.context, {
                ctx: harness.ctx,
                toolCallId: "call-1",
            }),
        ).rejects.toThrow(/has not been read yet/);

        expect(first).toHaveBeenCalledOnce();
        expect(second).not.toHaveBeenCalled();
    });

    it("does not fall back after an indeterminate provider failure", async () => {
        const first = vi.fn().mockRejectedValue(new Error("connection reset"));
        const second = vi.fn();
        const tool = createImageGenerationTool(
            [
                { id: "first", imageGeneration: { generate: first } },
                { id: "second", imageGeneration: { generate: second } },
            ],
            imageGenerationSurface,
        );

        const harness = createJustBashToolHarness();
        await expect(
            tool.execute({ prompt: "A lighthouse in a storm" }, harness.context, {
                ctx: harness.ctx,
                toolCallId: "call-1",
            }),
        ).rejects.toThrow("connection reset");

        expect(second).not.toHaveBeenCalled();
    });

    it("rejects aggregate local image input before reading or generating", async () => {
        const generate = vi.fn();
        const tool = createImageGenerationTool(
            [{ id: "first", imageGeneration: { generate } }],
            imageGenerationSurface,
        );
        const harness = createJustBashToolHarness({
            files: {
                "/workspace/one.png": Buffer.from(validPng32Base64, "base64"),
                "/workspace/two.png": Buffer.from(validPng32Base64, "base64"),
            },
        });
        const stat = vi.spyOn(harness.context.fs, "stat");
        stat.mockResolvedValue({
            isDirectory: false,
            isFile: true,
            isSymbolicLink: false,
            mtimeMs: 0,
            size: 17 * 1024 * 1024,
        });

        await expect(
            tool.execute(
                {
                    prompt: "Combine these",
                    referenced_image_paths: ["one.png", "two.png"],
                },
                harness.context,
                { ctx: harness.ctx },
            ),
        ).rejects.toThrow("32 MiB aggregate");
        expect(generate).not.toHaveBeenCalled();
    });

    it("bounds the actual local image read after the size preflight", async () => {
        const generate = vi
            .fn()
            .mockResolvedValue({ base64: validPng32Base64, mediaType: "image/png" });
        const tool = createImageGenerationTool(
            [{ id: "first", imageGeneration: { generate } }],
            imageGenerationSurface,
        );
        const harness = createJustBashToolHarness({
            files: { "/workspace/reference.png": Buffer.from(validPng32Base64, "base64") },
        });
        const readFileBuffer = vi.spyOn(harness.context.fs, "readFileBuffer");

        await tool.execute(
            {
                prompt: "Add a red hat",
                referenced_image_paths: ["reference.png"],
            },
            harness.context,
            { ctx: harness.ctx, toolCallId: "bounded-read" },
        );

        expect(readFileBuffer).toHaveBeenCalledWith("/workspace/reference.png", {
            maxBytes: 32 * 1024 * 1024,
        });
    });

    it("fully discloses recent images and multi-provider fallback in Auto review", () => {
        const tool = createImageGenerationTool(
            [
                { id: "first", imageGeneration: { generate: vi.fn() } },
                { id: "second", imageGeneration: { generate: vi.fn() } },
            ],
            imageGenerationSurface,
        );

        const disclosure = tool.describeAutoPermissionAction?.(
            { num_last_images_to_include: 2, prompt: "Edit these" },
            createJustBashToolHarness().context,
        );

        expect(disclosure).toContain("2 recent conversation image(s)");
        expect(disclosure).toContain("another of 2 configured Codex cloud provider(s)");
        expect(disclosure).toContain("custom endpoints");
    });

    it("gives Codex models the same capability under a name the Responses API allows", () => {
        const tool = createImageGenerationTool(
            [{ id: "first", imageGeneration: { generate: vi.fn() } }],
            codexImageGenerationSurface,
        );

        expect(tool.name).toBe("codex_imagegen");
        expect(tool.namespace).toBeUndefined();
        expect(tool.description).toContain("referenced_image_paths");
        expect(tool.description).not.toContain("view_image");
    });

    it("treats a null selector as an unused selector", async () => {
        const generate = vi
            .fn()
            .mockResolvedValue({ base64: validPng32Base64, mediaType: "image/png" });
        const tool = createImageGenerationTool(
            [{ id: "first", imageGeneration: { generate } }],
            codexImageGenerationSurface,
        );
        const harness = createJustBashToolHarness();

        const nulled = {
            num_last_images_to_include: null,
            prompt: "A lighthouse in a storm",
            referenced_image_paths: null,
        };
        expect(Value.Check(tool.arguments, nulled)).toBe(true);

        await tool.execute(nulled, harness.context, { ctx: harness.ctx, toolCallId: "nulled" });

        expect(generate).toHaveBeenCalledOnce();
        expect(generate.mock.calls[0]?.[0]).not.toHaveProperty("images");
    });

    it.each([
        ["invalid base64", "!!!!", "invalid base64"],
        ["non-PNG data", Buffer.from("not a png").toString("base64"), "not a PNG"],
        [
            "malformed PNG",
            Buffer.concat([
                Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
                Buffer.from("broken"),
            ]).toString("base64"),
            "malformed PNG",
        ],
    ])("rejects %s returned by a provider", async (_name, base64, message) => {
        const tool = createImageGenerationTool(
            [
                {
                    id: "first",
                    imageGeneration: {
                        generate: vi.fn().mockResolvedValue({ base64, mediaType: "image/png" }),
                    },
                },
            ],
            imageGenerationSurface,
        );

        const harness = createJustBashToolHarness();
        await expect(
            tool.execute({ prompt: "A lighthouse" }, harness.context, {
                ctx: harness.ctx,
                toolCallId: "call-bad",
            }),
        ).rejects.toThrow(message);
    });
});
