import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentProviders, type AgentModuleScope } from "@slopus/happy-agent-base";
import { CodexApiKeyCredential, CodexProvider } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";
import { ImageGenerationModule } from "../../sources/imageGeneration/ImageGenerationModule.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const ctx = createRootContext().named("happy-agent-modules-image-generation");
const AGENT_ID = "agent-one";

let happyRoot: string;
let outputDirectory: string;
let responses: Response[];
let requests: { url: string; init: RequestInit | undefined }[];

/** A real PNG, because everything the module writes is proven to be a decodable image first. */
async function png(): Promise<Buffer> {
    return await sharp({
        create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
        .png()
        .toBuffer();
}

function imageResponse(base64: string, status = 200): Response {
    return new Response(JSON.stringify({ data: [{ b64_json: base64 }] }), { status });
}

function refusal(status: number, message: string): Response {
    return new Response(JSON.stringify({ error: { message } }), { status });
}

/** One configured Codex account, reachable through the real provider the module looks for. */
async function codexAccount(): Promise<CodexProvider> {
    const credential = await CodexApiKeyCredential.tryLoad({ apiKey: "test-key" });
    return new CodexProvider({
        credential: credential!,
        endpoint: "https://images.test/v1",
        userAgent: "rig-image-test/1.0",
    });
}

/**
 * The module over a configuration whose accounts are the ones this test registered.
 *
 * Configuration is what owns the accounts, so a scripted registry reaches the module the same way
 * a person's own Codex sign-in would: through `ConfigModule`, not around it.
 */
async function moduleWith(
    accounts: Readonly<Record<string, CodexProvider>>,
    type: "codex" | "bedrock" = "codex",
): Promise<ImageGenerationModule> {
    const providers = new AgentProviders();
    for (const [id, provider] of Object.entries(accounts)) providers.add(id, provider, type);
    return new ImageGenerationModule(
        await ConfigModule.load(join(happyRoot, ".happy"), {
            inference: { models: [], providers },
        }),
    );
}

function scope(model: string): AgentModuleScope {
    return { agent: { id: AGENT_ID, model, provider: "work" } } as AgentModuleScope;
}

beforeEach(async () => {
    happyRoot = await mkdtemp(join(tmpdir(), "rig-imagegen-"));
    outputDirectory = join(happyRoot, "Happy", "Generated");
    responses = [];
    requests = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        const next = responses.shift();
        if (next === undefined) throw new Error("The test made an unexpected image request.");
        return next;
    });
});

afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(happyRoot, { force: true, recursive: true });
});

describe("ImageGenerationModule", () => {
    it("writes the image it generated and hands the model both the file and the picture", async () => {
        const bytes = await png();
        responses = [imageResponse(bytes.toString("base64"))];
        const module = await moduleWith({ work: await codexAccount() });

        const result = await module.generate(
            ctx,
            AGENT_ID,
            { prompt: "A small orange fox" },
            { turnId: "call-1", preferredProviderId: "work" },
        );

        expect(result.media_type).toBe("image/png");
        expect(result.bytes).toBe(bytes.byteLength);
        expect(result.path).toBe(join(outputDirectory, "call-1.png"));
        expect(await readFile(result.path)).toEqual(bytes);
        expect(requests[0]?.url).toBe("https://images.test/v1/images/generations");

        const hooks = await resolveModuleHooks(ctx, module);
        const [tool] = await hooks.tools!(ctx, scope("anthropic/opus-5"));
        expect(tool!.toLLM(result)).toEqual([
            {
                type: "text",
                text: `Generated image at ${result.path} (${String(bytes.byteLength)} bytes).`,
            },
            { type: "image", mimeType: "image/png", data: result.image_base64 },
        ]);
    });

    it("gives every model family the same single image tool", async () => {
        const module = await moduleWith({ work: await codexAccount() });
        const hooks = await resolveModuleHooks(ctx, module);

        const codex = await hooks.tools!(ctx, scope("openai/gpt-5.6-sol"));
        const claude = await hooks.tools!(ctx, scope("anthropic/opus-5"));

        expect(codex.map((tool) => tool.name)).toEqual(["codex_imagegen"]);
        expect(claude.map((tool) => tool.name)).toEqual(["codex_imagegen"]);
        for (const tool of [...codex, ...claude]) {
            expect(tool.durable).toBe(false);
            expect(tool.requiresAutoOrFullAccess).toBe(true);
            expect(tool.shouldReviewInAutoMode({ prompt: "a fox" }, ctx)).toBe(true);
            expect(tool.describeAutoPermissionAction!({ prompt: 'a "fox"' }, ctx)).toContain(
                '\\"fox\\"',
            );
        }
    });

    it("refuses to build one edit from both selectors", async () => {
        const module = await moduleWith({ work: await codexAccount() });

        await expect(
            module.generate(
                ctx,
                AGENT_ID,
                {
                    prompt: "Add a red hat",
                    num_last_images_to_include: 1,
                    referenced_image_paths: ["/tmp/fox.png"],
                },
                { turnId: "call-2" },
            ),
        ).rejects.toThrow("Provide only one of");
    });

    it("tries the next account when one definitively refuses", async () => {
        const bytes = await png();
        responses = [refusal(402, "Out of credit."), imageResponse(bytes.toString("base64"))];
        const module = await moduleWith({
            work: await codexAccount(),
            personal: await codexAccount(),
        });

        const result = await module.generate(
            ctx,
            AGENT_ID,
            { prompt: "A small orange fox" },
            { turnId: "call-3", preferredProviderId: "work" },
        );

        expect(result.bytes).toBe(bytes.byteLength);
        expect(requests).toHaveLength(2);
    });

    it("stops at a failure that is not an account refusing the request", async () => {
        responses = [refusal(400, "The prompt was rejected.")];
        const module = await moduleWith({
            work: await codexAccount(),
            personal: await codexAccount(),
        });

        await expect(
            module.generate(
                ctx,
                AGENT_ID,
                { prompt: "A small orange fox" },
                { turnId: "call-4", preferredProviderId: "work" },
            ),
        ).rejects.toThrow("The prompt was rejected.");
        // The first request may already have been billed, so a second account is never asked.
        expect(requests).toHaveLength(1);
    });

    it("refuses to publish an answer that is not a PNG", async () => {
        responses = [imageResponse("AQID")];
        const module = await moduleWith({ work: await codexAccount() });

        await expect(
            module.generate(
                ctx,
                AGENT_ID,
                { prompt: "A small orange fox" },
                { turnId: "call-5", preferredProviderId: "work" },
            ),
        ).rejects.toThrow("not a PNG image");
    });

    it("says so when it was asked for more conversation images than it was shown", async () => {
        const module = await moduleWith({ work: await codexAccount() });

        await expect(
            module.generate(
                ctx,
                AGENT_ID,
                { prompt: "Add a red hat", num_last_images_to_include: 2 },
                { turnId: "call-6", preferredProviderId: "work" },
            ),
        ).rejects.toThrow("only 0 were available");
    });

    it("edits the image a person attached", async () => {
        const bytes = await png();
        responses = [imageResponse(bytes.toString("base64"))];
        const module = await moduleWith({ work: await codexAccount() });
        const hooks = await resolveModuleHooks(ctx, module);

        await hooks.messageAccepted!(ctx, scope("openai/gpt-5.6-sol"), {
            id: "message-1",
            kind: "send",
            message: {
                role: "user",
                content: [{ type: "image", data: "AQID", mimeType: "image/png" }],
            },
        });
        await module.generate(
            ctx,
            AGENT_ID,
            { prompt: "Add a red hat", num_last_images_to_include: 1 },
            { turnId: "call-7", preferredProviderId: "work" },
        );

        expect(requests[0]?.url).toBe("https://images.test/v1/images/edits");
        expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
            images: [{ image_url: "data:image/png;base64,AQID" }],
            prompt: "Add a red hat",
        });
    });

    it("has nothing to generate with when no Codex account is configured", async () => {
        const module = await moduleWith({});

        await expect(
            module.generate(ctx, AGENT_ID, { prompt: "A small orange fox" }, { turnId: "call-8" }),
        ).rejects.toThrow("No Codex account is configured");
    });

    it("offers no image tool when no Codex account is configured", async () => {
        const module = await moduleWith({});
        const hooks = await resolveModuleHooks(ctx, module);

        expect(await hooks.tools!(ctx, scope("anthropic/opus-5"))).toEqual([]);
    });

    it("offers no image tool when only non-Codex accounts exist", async () => {
        const module = await moduleWith({ bedrock: await codexAccount() }, "bedrock");
        const hooks = await resolveModuleHooks(ctx, module);

        expect(await hooks.tools!(ctx, scope("anthropic/opus-5"))).toEqual([]);
    });
});
