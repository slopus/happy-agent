import type { AnyDefinedTool } from "../agent/types.js";
import type { Model, Provider } from "@slopus/rig-execution";
import { claudeToolSurface } from "../agent/tools/claude/assembleClaudeTools.js";
import { assembleCodexTools } from "../agent/tools/codex/assembleCodexTools.js";
import { codexCollaborationTools } from "../agent/tools/codex/assembleCodexTools.js";
import { grokBuildTools } from "../tools/grok/index.js";
import {
    createImageGenerationTool,
    type ImageGenerationProvider,
} from "../tools/imageGeneration/createImageGenerationTool.js";
import {
    codexImageGenerationSurface,
    imageGenerationSurface,
} from "../tools/imageGeneration/imageGenerationSurfaces.js";
import { webSearchCapability } from "./webSearchCapability.js";

export interface SelectToolsForModelOptions {
    imageGeneration?: readonly ImageGenerationProvider[];
    provider: Provider;
    model: Model;
}

export function selectToolsForModel(
    options: SelectToolsForModelOptions,
): readonly AnyDefinedTool[] {
    const toolType =
        options.provider.type === "bedrock"
            ? options.model.id.startsWith("anthropic/")
                ? "claude"
                : "codex"
            : options.provider.type;
    const vendor = toolType === "claude" ? "claude" : toolType === "grok" ? "grok" : "codex";
    const collaborationNames = new Set(codexCollaborationTools.map((tool) => tool.name));
    // Search is chosen when the surface is built, not removed from it afterwards. The endpoint
    // decides: Bedrock serves the same Anthropic model without Anthropic's server-side search.
    const webSearch = webSearchCapability(options.provider, options.model) === "claude_auxiliary";
    const baseTools =
        vendor === "claude"
            ? claudeToolSurface({ webSearch })
            : vendor === "grok"
              ? grokBuildTools
              : assembleCodexTools(
                    options.model.id,
                    options.provider.type ?? options.provider.id,
                ).filter((tool) => !collaborationNames.has(tool.name));
    return [
        ...baseTools,
        ...imageGenerationTools(options.imageGeneration ?? [], vendor),
    ] as readonly AnyDefinedTool[];
}

/**
 * Image generation is one Rig capability behind a vendor-shaped surface: Codex models get the
 * name and guidance their training expects, and every other family gets Rig's plain wording.
 */
function imageGenerationTools(
    providers: readonly ImageGenerationProvider[],
    vendor: "claude" | "codex" | "grok",
): readonly AnyDefinedTool[] {
    if (providers.length === 0) return [];
    return [
        createImageGenerationTool(
            providers,
            vendor === "codex" ? codexImageGenerationSurface : imageGenerationSurface,
        ),
    ];
}
