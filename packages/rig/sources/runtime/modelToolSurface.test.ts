import { describe, expect, it } from "vitest";
import {
    builtinModelProfiles,
    defineProvider,
    modelAnthropicSonnet5,
    modelOpenaiGpt56Luna,
    modelOpenaiGpt56Sol,
    modelXaiGrokBuild,
    type Model,
    type ProfileProviderType,
} from "@slopus/rig-execution";

import { gymModel } from "../executor/createGymProvider.js";
import { modelToolSurface } from "./modelToolSurface.js";

describe("modelToolSurface", () => {
    it("covers every model exposed by every configured provider type", () => {
        for (const providerType of ["claude", "codex", "grok", "bedrock"] as const) {
            const profiles = builtinModelProfiles(providerType, providerType);
            const provider = fixedProvider(
                providerType,
                profiles.map((profile) => profile.model),
            );
            for (const profile of profiles) {
                expect(() => modelToolSurface({ model: profile.model, provider })).not.toThrow();
            }
        }
    });

    it("uses exact fixed collaboration arrays for each route", () => {
        const claude = modelToolSurface({
            model: modelAnthropicSonnet5,
            provider: fixedProvider("bedrock", [modelAnthropicSonnet5]),
        });
        expect(claude.collaborationTools.map((tool) => tool.name)).toEqual([
            "Agent",
            "Workflow",
            "WaitForWorkflow",
            "SendMessage",
        ]);
        expect(claude.limitedCollaborationTools.map((tool) => tool.name)).toEqual(["SendMessage"]);

        const codexV2 = modelToolSurface({
            model: modelOpenaiGpt56Sol,
            provider: fixedProvider("codex", [modelOpenaiGpt56Sol]),
        });
        expect(namespaced(codexV2.collaborationTools, "collaboration")).toContain("spawn_agent");
        expect(namespaced(codexV2.limitedCollaborationTools, "collaboration")).not.toContain(
            "spawn_agent",
        );

        const codexV1 = modelToolSurface({
            model: modelOpenaiGpt56Luna,
            provider: fixedProvider("codex", [modelOpenaiGpt56Luna]),
        });
        expect(namespaced(codexV1.collaborationTools, "multi_agent_v1")).toContain("spawn_agent");
        expect(namespaced(codexV1.limitedCollaborationTools, "multi_agent_v1")).toEqual([
            "close_agent",
            "resume_agent",
            "send_input",
            "wait_agent",
        ]);

        const bedrockCodex = modelToolSurface({
            model: modelOpenaiGpt56Sol,
            provider: fixedProvider("bedrock", [modelOpenaiGpt56Sol]),
        });
        expect(namespaced(bedrockCodex.collaborationTools, "multi_agent_v1")).toContain(
            "spawn_agent",
        );

        const grok = modelToolSurface({
            model: modelXaiGrokBuild,
            provider: fixedProvider("grok", [modelXaiGrokBuild]),
        });
        expect(grok.limitedCollaborationTools.map((tool) => tool.name)).toEqual([
            "followup_subagent",
        ]);
        expect(grok.baseTools.map((tool) => tool.name)).toEqual([
            "get_subagent_output",
            "kill_subagent",
        ]);
    });

    it("maps the actual standalone Gym route explicitly", () => {
        const surface = modelToolSurface({
            model: gymModel,
            provider: fixedProvider(undefined, [gymModel]),
        });

        expect(namespaced(surface.collaborationTools, "collaboration")).toContain("spawn_agent");
        expect(surface.imageGenerationSurface.name).toBe("codex_imagegen");
    });
});

function fixedProvider(type: ProfileProviderType | undefined, models: readonly Model[]) {
    return defineProvider({
        id: type ?? "gym",
        models,
        ...(type === undefined ? {} : { type }),
        stream: () => {
            throw new Error("Inference is not used by this test.");
        },
    });
}

function namespaced(
    tools: ReturnType<typeof modelToolSurface>["collaborationTools"],
    namespace: string,
): string[] {
    return tools.filter((tool) => tool.namespace?.name === namespace).map((tool) => tool.name);
}
