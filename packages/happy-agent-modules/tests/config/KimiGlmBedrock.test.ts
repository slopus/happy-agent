import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GlmProvider, KimiProvider, type BaseProvider } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function configuration(extra = "") {
    const root = await mkdtemp(join(tmpdir(), "happy-kimi-glm-catalog-"));
    roots.push(root);
    const folder = join(root, process.platform === "darwin" ? "Happy/Config" : "happy/config");
    await mkdir(folder, { recursive: true });
    await writeFile(
        join(folder, "happy.toml"),
        [
            "[providers]",
            "default_enable = false",
            "[providers.bedrock]",
            "enabled = true",
            'region = "us-east-1"',
            'bearer_token = "test-placeholder"',
            extra,
        ].join("\n"),
    );
    return await ConfigModule.load(join(root, ".happy"));
}

describe("Kimi K3 and GLM 5.3 Bedrock agent routes", () => {
    it("advertises the documented Bedrock models and their executable effort choices", async () => {
        const config = await configuration();
        for (const [id, name, defaultEffort] of [
            ["moonshotai/kimi-k3", "Kimi K3", "high"],
            ["zai/glm-5.3", "GLM 5.3", "max"],
        ] as const) {
            expect(config.catalog.filter((entry) => entry.id === id)).toEqual([
                expect.objectContaining({
                    id,
                    name,
                    defaultEffort,
                    providerId: "bedrock",
                    enabled: true,
                    effortLevels: ["low", "high", "max"],
                    contextWindow: 1_000_000,
                    autoCompactWindow: 850_000,
                }),
            ]);
            expect(config.modelContext("bedrock", id)).toEqual({
                contextWindow: 1_000_000,
                autoCompactWindow: 850_000,
            });
        }
        expect(await config.providers.resolve("bedrock", "moonshotai/kimi-k3")).toBeInstanceOf(
            KimiProvider,
        );
        expect(await config.providers.resolve("bedrock", "zai/glm-5.3")).toBeInstanceOf(
            GlmProvider,
        );
    });

    it.each([
        ["moonshotai/kimi-k3", "Kimi K3"],
        ["zai/glm-5.3", "GLM 5.3"],
    ])("hides a Mantle route for %s that names no endpoint", async (id, name) => {
        const config = await configuration(
            `\n[providers.bedrock.model_overrides."${id}"]\ntransport = "mantle"`,
        );
        expect(config.catalog.some((entry) => entry.id === id)).toBe(false);
        await expect(config.providers.resolve("bedrock", id)).rejects.toThrow(
            `AWS does not serve ${name} on Bedrock Mantle.`,
        );
    });

    it.each([
        ["moonshotai/kimi-k3", "moonshotai.kimi-k3"],
        ["zai/glm-5.3", "zai.glm-5.3"],
    ])("sends %s to a Mantle route that names its endpoint", async (id, wire) => {
        const server = await captureServer();
        const config = await configuration(
            `\n[providers.bedrock.model_overrides."${id}"]\ntransport = "mantle"\nendpoint = "${server.url}/v1"`,
        );
        expect(config.catalog.some((entry) => entry.id === id)).toBe(true);
        const request = await server.capture(await config.providers.resolve("bedrock", id), id);
        expect(request.url).toBe("/v1/chat/completions");
        expect(JSON.parse(request.body)).toMatchObject({ model: wire });
    });

    it("preserves ordinary model filters and exposes the same models through a smart Bedrock pool", async () => {
        const config = await configuration(
            [
                'include_models = ["moonshotai/kimi-k3", "zai/glm-5.3"]',
                'exclude_models = ["zai/glm-5.3"]',
                "[providers.pool]",
                'type = "smart"',
                "enabled = true",
                'providers = ["bedrock"]',
            ].join("\n"),
        );
        expect(
            config.catalog.find(
                (entry) => entry.providerId === "bedrock" && entry.id === "zai/glm-5.3",
            )?.enabled,
        ).toBe(false);
        expect(
            config.catalog.find(
                (entry) => entry.providerId === "pool" && entry.id === "moonshotai/kimi-k3",
            )?.enabled,
        ).toBe(true);
        expect(
            config.catalog.some(
                (entry) => entry.providerId === "pool" && entry.id === "zai/glm-5.3",
            ),
        ).toBe(false);
    });
});

const PROFILE =
    "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/curated-route";

describe("Bedrock model_id overrides", () => {
    it.each([
        ["anthropic/opus-5-5", 'transport = "runtime"', ""],
        ["openai/gpt-6-sol", 'transport = "runtime"', "/openai/v1"],
        ["moonshotai/kimi-k3", "", "/openai/v1"],
        ["zai/glm-5.3", "", "/openai/v1"],
    ])("sends the model_id of %s verbatim as the wire model", async (id, transport, path) => {
        const server = await captureServer();
        const config = await configuration(
            [
                `[providers.bedrock.model_overrides."${id}"]`,
                `model_id = "${PROFILE}"`,
                `endpoint = "${server.url}${path}"`,
                transport,
            ].join("\n"),
        );
        const request = await server.capture(await config.providers.resolve("bedrock", id), id);
        const inPath = /\/model\/([^/]+)\/invoke/u.exec(request.url)?.[1];
        expect(
            inPath === undefined
                ? (JSON.parse(request.body) as { model: string }).model
                : decodeURIComponent(inPath),
        ).toBe(PROFILE);
    });

    it("keeps the curated model's picker entry, efforts, and windows", async () => {
        const plain = await configuration();
        const mapped = await configuration(
            `[providers.bedrock.model_overrides."anthropic/opus-5-5"]\nmodel_id = "${PROFILE}"`,
        );
        const entry = (config: ConfigModule) =>
            config.catalog.find(
                (candidate) =>
                    candidate.providerId === "bedrock" && candidate.id === "anthropic/opus-5-5",
            );
        expect(entry(mapped)).toBeDefined();
        expect(entry(mapped)).toEqual(entry(plain));
        expect(mapped.modelContext("bedrock", "anthropic/opus-5-5")).toEqual(
            plain.modelContext("bedrock", "anthropic/opus-5-5"),
        );
    });

    it.each(["https://example.com/model", "opus", "arn:aws:s3:::bucket/key"])(
        "names the full setting when model_id is %s",
        async (value) => {
            await expect(
                configuration(
                    `[providers.bedrock.model_overrides."anthropic/opus-5-5"]\nmodel_id = "${value}"`,
                ),
            ).rejects.toThrow(
                'providers.bedrock.model_overrides."anthropic/opus-5-5".model_id must be a Bedrock model or inference-profile ARN or ID.',
            );
        },
    );
});

const servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => await server.close()));
});

/** A local endpoint that records the first request it receives and refuses it. */
async function captureServer() {
    let captured: { url: string; body: string } | undefined;
    const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.once("end", () => {
            captured ??= {
                url: request.url ?? "",
                body: Buffer.concat(chunks).toString("utf8"),
            };
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ message: "Captured." }));
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    servers.push({
        close: async () => await new Promise<void>((resolve) => server.close(() => resolve())),
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port.");
    return {
        url: `http://127.0.0.1:${address.port}`,
        async capture(provider: BaseProvider | null, model: string) {
            if (provider === null) throw new Error(`${model} has no provider.`);
            const session = await provider.session("bedrock-model-override", {
                instructions: "",
                tools: [],
                inferenceMaxRetries: 0,
            });
            try {
                for await (const _event of session.run(createRootContext(), {
                    model,
                    context: {
                        instructions: "",
                        messages: [{ role: "user", content: [{ type: "text", text: "Hello." }] }],
                    },
                })) {
                    // Draining the stream is what sends the request under test.
                }
            } catch {
                // The server refuses the request once it has recorded it.
            } finally {
                session.destroy();
            }
            if (captured === undefined) throw new Error(`${model} sent no request.`);
            return captured;
        },
    };
}
