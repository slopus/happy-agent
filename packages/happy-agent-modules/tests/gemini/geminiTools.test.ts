import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GeminiModule } from "../../sources/gemini/index.js";
import { FakeCompute } from "../compute/support/FakeCompute.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import { geminiToolset } from "./support/geminiTools.js";
import { scriptedComputeModule, testConfig } from "../support/computeModule.js";

const ctx = createRootContext().named("happy-agent-modules-gemini-tools");

// The key is configuration's to resolve, and it resolves it from the environment. Every test here
// runs as an installation that has one; the last one runs as an installation that does not.
beforeEach(() => {
    vi.stubEnv("GEMINI_API_KEY", "secret-key");
});

afterEach(() => {
    vi.unstubAllEnvs();
});

/** A Gemini interaction response, as the API would answer it. */
function interaction(...content: readonly Record<string, unknown>[]): Response {
    return new Response(JSON.stringify({ steps: [{ type: "model_output", content }] }), {
        status: 200,
    });
}

/** A machine with Gemini's tools over it, answering with whatever the test scripted. */
async function machine(answer: (() => Response) | undefined = undefined) {
    const compute = new FakeCompute();
    const request = vi.fn(() => Promise.resolve(answer?.() ?? new Response("{}", { status: 200 })));
    const toolset = await geminiToolset(ctx, compute, {
        fetch: request as unknown as typeof fetch,
    });
    return { compute, request, ...toolset };
}

/** The body one request carried, as an object. */
function requestBody(request: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const init = request.mock.calls[0]?.[1] as RequestInit | undefined;
    return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("the Gemini module's tools", () => {
    it("offers exactly the three Gemini media tools, each declaring its external boundary", async () => {
        const { tools } = await machine();

        expect(tools.map((tool) => tool.name)).toEqual([
            "gemini_imagegen",
            "gemini_generate_music",
            "gemini_analyze_media",
        ]);
        expect(tools.every((tool) => tool.requiresAutoOrFullAccess === true)).toBe(true);
        expect(
            await Promise.all(
                tools.map(async (tool) => await tool.shouldReviewInAutoMode({}, ctx)),
            ),
        ).toEqual([true, true, true]);
    });

    it("has no tools at all when the agent has no machine to write to", async () => {
        const module = new GeminiModule(
            testConfig,
            scriptedComputeModule(async () => undefined),
        );

        const hooks = await resolveModuleHooks(ctx, module);
        expect(await hooks.tools!(ctx, { agent: { id: "a" }, kv: undefined } as never)).toEqual([]);
    });

    it("has no tools at all when the installation has no Gemini key", async () => {
        vi.stubEnv("GEMINI_API_KEY", "");
        const compute = new FakeCompute();
        const module = new GeminiModule(
            testConfig,
            scriptedComputeModule(async () => compute),
        );

        const hooks = await resolveModuleHooks(ctx, module);
        expect(await hooks.tools!(ctx, { agent: { id: "a" }, kv: undefined } as never)).toEqual([]);
    });

    it("writes a generated image through the agent's own filesystem", async () => {
        const { compute, request, tool } = await machine(() =>
            interaction(
                { type: "text", text: "A quiet mountain lake." },
                { type: "image", mime_type: "image/png", data: "AQID" },
            ),
        );

        const result = await tool("gemini_imagegen").execute(ctx, {
            aspect_ratio: "16:9",
            image_size: "2K",
            output_path: "art/generated.png",
            prompt: "A quiet mountain lake",
        });

        expect(result.path).toBe("/workspace/art/generated.png");
        expect(result.bytes).toBe(3);
        expect(result.mime_type).toBe("image/png");
        expect(result.description).toBe("A quiet mountain lake.");
        expect(await compute.fs.readFileBuffer({} as never, result.path)).toEqual(
            new Uint8Array([1, 2, 3]),
        );
        expect(requestBody(request)).toMatchObject({
            input: "A quiet mountain lake",
            model: "gemini-3.1-flash-image",
            response_format: { aspect_ratio: "16:9", image_size: "2K", type: "image" },
        });
        expect(tool("gemini_imagegen").toLLM(result)).toEqual([
            {
                type: "text",
                text: "Generated image at /workspace/art/generated.png (3 bytes).\n\nA quiet mountain lake.",
            },
        ]);
    });

    it("refuses an output path that is not a .png before spending a generation", async () => {
        const { request, tool } = await machine();

        await expect(
            tool("gemini_imagegen").execute(ctx, {
                output_path: "art/generated.jpg",
                prompt: "A quiet mountain lake",
            }),
        ).rejects.toThrow("Gemini image output_path must end in .png.");
        expect(request).not.toHaveBeenCalled();
    });

    it("overwrites an existing output without a prior read", async () => {
        const { compute, request, tool } = await machine(() =>
            interaction({ type: "image", mime_type: "image/png", data: "AQID" }),
        );
        compute.writeBuffer("/workspace/existing.png", new Uint8Array([9]));

        const result = await tool("gemini_imagegen").execute(ctx, {
            output_path: "existing.png",
            prompt: "A replacement image",
        });

        expect(result.path).toBe("/workspace/existing.png");
        expect(await compute.fs.readFileBuffer({} as never, result.path)).toEqual(
            new Uint8Array([1, 2, 3]),
        );
        expect(request).toHaveBeenCalledOnce();
    });

    it("reports the exact action and boundary a reviewer decides on", async () => {
        const { tool } = await machine();

        expect(
            tool("gemini_imagegen").describeAutoPermissionAction!(
                { output_path: "art/generated.png", prompt: 'A "quiet"\nlake' },
                ctx,
            ),
        ).toBe(
            'sending "A \\"quiet\\"\\nlake" to Gemini image generation and writing "art/generated.png". Access: external Gemini API and local filesystem write',
        );
        expect(
            tool("gemini_analyze_media").describeAutoPermissionAction!(
                { path: "audio.mp3", prompt: "Describe this clip" },
                ctx,
            ),
        ).toBe(
            'uploading "audio.mp3" to Gemini for "Describe this clip". Access: local filesystem read and external Gemini API',
        );
    });

    it("writes generated music and asks for a clip unless a song was requested", async () => {
        const { compute, request, tool } = await machine(() =>
            interaction(
                { type: "text", text: "[Verse]\nHello" },
                { type: "audio", mime_type: "audio/mp3", data: "BAUG" },
            ),
        );

        const result = await tool("gemini_generate_music").execute(ctx, {
            output_path: "audio/theme.mp3",
            prompt: "An instrumental game theme",
        });

        expect(result.path).toBe("/workspace/audio/theme.mp3");
        expect(result.lyrics).toBe("[Verse]\nHello");
        expect(await compute.fs.readFileBuffer({} as never, result.path)).toEqual(
            new Uint8Array([4, 5, 6]),
        );
        expect(requestBody(request)).toMatchObject({
            input: "An instrumental game theme",
            model: "lyria-3-clip-preview",
        });
    });

    it("refuses an output path that is not an .mp3 before spending a generation", async () => {
        const { request, tool } = await machine();

        await expect(
            tool("gemini_generate_music").execute(ctx, {
                output_path: "audio/theme.wav",
                prompt: "An instrumental game theme",
            }),
        ).rejects.toThrow("Gemini music output_path must end in .mp3.");
        expect(request).not.toHaveBeenCalled();
    });

    it("names the media type of a local file and returns Gemini's answer about it", async () => {
        const { compute, request, tool } = await machine(() =>
            interaction({ type: "text", text: "The clip contains a piano melody." }),
        );
        compute.writeBuffer("/workspace/audio.mp3", new Uint8Array([7, 8, 9]));

        const result = await tool("gemini_analyze_media").execute(ctx, {
            path: "audio.mp3",
            prompt: "Describe this clip",
        });

        expect(result).toEqual({
            analysis: "The clip contains a piano melody.",
            mime_type: "audio/mp3",
            path: "/workspace/audio.mp3",
        });
        expect(requestBody(request)).toMatchObject({
            input: [
                { data: "BwgJ", mime_type: "audio/mp3", type: "audio" },
                { text: "Describe this clip", type: "text" },
            ],
            model: "gemini-3.5-flash",
        });
    });

    it("reads a PDF as a document and a photograph as an image", async () => {
        const { compute, request, tool } = await machine(() =>
            interaction({ type: "text", text: "A one-page invoice." }),
        );
        compute.writeBuffer("/workspace/invoice.pdf", new Uint8Array([1]));
        compute.writeBuffer("/workspace/photo.JPG", new Uint8Array([2]));

        expect(
            (
                await tool("gemini_analyze_media").execute(ctx, {
                    path: "invoice.pdf",
                    prompt: "Summarize this",
                })
            ).mime_type,
        ).toBe("application/pdf");
        expect(requestBody(request).input).toMatchObject([{ type: "document" }, { type: "text" }]);
        expect(
            (
                await tool("gemini_analyze_media").execute(ctx, {
                    path: "photo.JPG",
                    prompt: "Describe this",
                })
            ).mime_type,
        ).toBe("image/jpeg");
    });

    it("refuses a file whose kind it cannot name for Gemini", async () => {
        const { compute, request, tool } = await machine();
        compute.write("/workspace/notes.txt", "hello");

        await expect(
            tool("gemini_analyze_media").execute(ctx, {
                path: "notes.txt",
                prompt: "Describe this",
            }),
        ).rejects.toThrow(/Unsupported Gemini media file extension/);
        expect(request).not.toHaveBeenCalled();
    });

    it("keeps work inside the workspace out of Full access, and everything else in it", async () => {
        const { tool } = await machine();

        expect(
            await tool("gemini_imagegen").shouldRunInFullAccessInAutoMode!(
                { output_path: "art/generated.png", prompt: "A lake" },
                ctx,
            ),
        ).toBe(false);
        expect(
            await tool("gemini_imagegen").shouldRunInFullAccessInAutoMode!(
                { output_path: "/etc/generated.png", prompt: "A lake" },
                ctx,
            ),
        ).toBe(true);
        expect(
            await tool("gemini_analyze_media").shouldRunInFullAccessInAutoMode!(
                { path: "/etc/hosts", prompt: "Describe this" },
                ctx,
            ),
        ).toBe(true);
    });
});
