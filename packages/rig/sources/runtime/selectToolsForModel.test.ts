import { describe, expect, it } from "vitest";

import { selectToolsForModel } from "./selectToolsForModel.js";
import { selectCommonToolsForModel } from "./selectCommonToolsForModel.js";
import { modelAnthropicSonnet46, modelXaiGrokBuild } from "@slopus/rig-execution";
import { defineProvider } from "@slopus/rig-execution";
import { grokBuildTools } from "../tools/grok/index.js";

describe("selectToolsForModel", () => {
    it("selects the Grok tool surface for Grok models", () => {
        const provider = defineProvider({
            id: "custom-xai-provider",
            models: [modelXaiGrokBuild],
            type: "grok",
            stream: () => {
                throw new Error("Inference is not used by this test.");
            },
        });

        expect(selectToolsForModel({ model: modelXaiGrokBuild, provider })).toEqual(grokBuildTools);
    });

    it("names the image tool for each model family and never duplicates it", () => {
        const imageGeneration = [
            {
                id: "codex",
                imageGeneration: { generate: () => Promise.reject(new Error("unused")) },
            },
        ];

        const named = (toolProfile: "claude" | "codex" | "grok") =>
            selectToolsForModel({
                imageGeneration,
                model: modelXaiGrokBuild,
                provider: providerWithToolProfile(toolProfile),
            })
                .map((tool) => tool.name)
                .filter((name) => name.endsWith("imagegen"));

        expect(named("codex")).toEqual(["codex_imagegen"]);
        expect(named("claude")).toEqual(["imagegen"]);
        expect(named("grok")).toEqual(["imagegen"]);
    });

    it("omits the image tool when no provider can generate images", () => {
        const tools = selectToolsForModel({
            imageGeneration: [],
            model: modelXaiGrokBuild,
            provider: providerWithToolProfile("codex"),
        });

        expect(tools.map((tool) => tool.name)).not.toContain("codex_imagegen");
    });

    it("keeps WebFetch but omits unsupported WebSearch for Bedrock Claude models", () => {
        const tools = selectToolsForModel({
            model: modelAnthropicSonnet46,
            provider: {
                id: "bedrock",
                type: "bedrock",
                models: [modelAnthropicSonnet46],
                serviceTiers: undefined,
                extendProfilePromptContext: undefined,
                stream: () => {
                    throw new Error("Not used");
                },
            },
        });

        expect(tools.map((tool) => tool.name)).toContain("WebFetch");
        expect(tools.map((tool) => tool.name)).not.toContain("WebSearch");
    });

    // Gemini is Rig's own tool, configured by holding a Gemini credential rather than by anything
    // about the selected model, so the common seam owns it and no vendor has to be taught about it.
    it("leaves Rig's own Gemini tools to the common seam", () => {
        for (const toolProfile of ["claude", "codex", "grok"] as const) {
            const names = selectToolsForModel({
                model: modelXaiGrokBuild,
                provider: providerWithToolProfile(toolProfile),
            }).map((tool) => tool.name);

            expect(names).not.toContain("gemini_search");
        }

        expect(
            selectCommonToolsForModel({
                geminiApiKey: "gemini-key",
                hasWorkspaceContext: false,
                isSubagent: false,
            }).map((tool) => tool.name),
        ).toEqual(
            expect.arrayContaining([
                "gemini_search",
                "gemini_generate_image",
                "gemini_generate_music",
                "gemini_analyze_media",
            ]),
        );
        expect(
            selectCommonToolsForModel({ hasWorkspaceContext: false, isSubagent: false }).map(
                (tool) => tool.name,
            ),
        ).not.toContain("gemini_search");
    });

    // The endpoint decides, not the tool's name. Bedrock serves the same Anthropic model without
    // Anthropic's server-side search, so it is never added there rather than added and removed.
    it("gives Claude's own search to the endpoints that can actually run it", () => {
        expect(
            selectToolsForModel({
                model: modelXaiGrokBuild,
                provider: providerWithToolProfile("claude"),
            }).filter((tool) => tool.name === "WebSearch"),
        ).toHaveLength(1);

        for (const toolProfile of ["codex", "grok"] as const) {
            expect(
                selectToolsForModel({
                    model: modelXaiGrokBuild,
                    provider: providerWithToolProfile(toolProfile),
                }).map((tool) => tool.name),
            ).not.toContain("WebSearch");
        }
    });
});

function providerWithToolProfile(toolProfile: "claude" | "codex" | "grok") {
    return defineProvider({
        id: `${toolProfile}-compatible-provider`,
        models: [modelXaiGrokBuild],
        type: toolProfile,
        stream: () => {
            throw new Error("Inference is not used by this test.");
        },
    });
}
