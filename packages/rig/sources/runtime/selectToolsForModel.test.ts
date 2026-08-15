import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
    defineProvider,
    modelAnthropicSonnet5,
    modelOpenaiGpt56Sol,
    modelXaiGrokBuild,
    type Model,
} from "@slopus/rig-execution";

import { defineTool } from "../agent/types.js";
import { selectCommonToolsForModel } from "./selectCommonToolsForModel.js";
import { selectToolsForModel } from "./selectToolsForModel.js";

describe("selectToolsForModel", () => {
    it("keeps search and web_fetch out of fixed vendor arrays", () => {
        for (const [providerType, model] of [
            ["claude", modelAnthropicSonnet5],
            ["codex", modelOpenaiGpt56Sol],
            ["grok", modelXaiGrokBuild],
        ] as const) {
            const names = selectToolsForModel({
                model,
                provider: provider(providerType, model),
            }).map((tool) => tool.name);

            expect(names).not.toContain("web_fetch");
            expect(names).not.toContain("WebSearch");
            expect(names).not.toContain("claude_web_search");
            expect(names).not.toContain("codex_web_search");
            expect(names).not.toContain("grok_web_search");
            expect(names).not.toContain("grok_x_search");
        }
    });

    it("omits compute tools from the explicit Claude array on Bedrock", () => {
        const names = selectToolsForModel({
            model: modelAnthropicSonnet5,
            provider: provider("bedrock", modelAnthropicSonnet5),
        }).map((tool) => tool.name);

        expect(names).toEqual(
            expect.arrayContaining(["TaskOutput", "TaskCreate", "AskUserQuestion"]),
        );
        expect(names).not.toEqual(
            expect.arrayContaining(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
        );
    });

    it("merges an explicit search array through the common seam", () => {
        const searchTool = defineTool({
            name: "example_search",
            label: "Example search",
            description: "Search.",
            arguments: Type.Object({}),
            returnType: Type.Null(),
            execute: () => null,
            toLLM: () => [],
            toUI: () => "Searched",
            shouldReviewInAutoMode: () => false,
            locks: [],
        });
        const names = selectCommonToolsForModel({
            hasFolderContext: false,
            hasWorkspaceContext: false,
            isSubagent: false,
            searchTools: [searchTool],
        }).map((tool) => tool.name);

        expect(names[0]).toBe("example_search");
    });

    it("names the image tool from each exact model surface", () => {
        const imageGeneration = [
            {
                id: "codex",
                imageGeneration: { generate: () => Promise.reject(new Error("unused")) },
            },
        ];
        const names = (providerType: "claude" | "codex" | "grok", model: Model) =>
            selectToolsForModel({
                imageGeneration,
                model,
                provider: provider(providerType, model),
            })
                .map((tool) => tool.name)
                .filter((name) => name.endsWith("imagegen"));

        expect(names("codex", modelOpenaiGpt56Sol)).toEqual(["codex_imagegen"]);
        expect(names("claude", modelAnthropicSonnet5)).toEqual(["imagegen"]);
        expect(names("grok", modelXaiGrokBuild)).toEqual(["imagegen"]);
    });

    it("rejects a provider/model pair absent from the fixed route table", () => {
        expect(() =>
            selectToolsForModel({
                model: modelXaiGrokBuild,
                provider: provider("claude", modelXaiGrokBuild),
            }),
        ).toThrow("No fixed tool array is configured");
    });
});

function provider(type: "bedrock" | "claude" | "codex" | "grok", model: Model) {
    return defineProvider({
        id: type,
        models: [model],
        type,
        stream: () => {
            throw new Error("Inference is not used by this test.");
        },
    });
}
