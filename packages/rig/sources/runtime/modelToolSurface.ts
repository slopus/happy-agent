import type { Model, Provider } from "@slopus/rig-execution";

import type { AnyDefinedTool } from "../agent/types.js";
import {
    claudeCollaborationTools,
    claudeCollaborationToolsWithoutWorkflows,
    claudeLimitedCollaborationTools,
    claudeTools,
} from "../agent/tools/claude/assembleClaudeTools.js";
import {
    codexTools,
    codexV1CollaborationTools,
    codexV1FullCollaborationTools,
    codexV1LimitedCollaborationTools,
    codexV2CollaborationTools,
    codexV2FullCollaborationTools,
    codexV2LimitedCollaborationTools,
} from "../agent/tools/codex/assembleCodexTools.js";
import {
    grokTools,
    grokCollaborationTools,
    grokLimitedCollaborationTools,
} from "../tools/grok/index.js";
import type { ImageGenerationSurface } from "../tools/imageGeneration/createImageGenerationTool.js";
import {
    codexImageGenerationSurface,
    imageGenerationSurface,
} from "../tools/imageGeneration/imageGenerationSurfaces.js";

export interface ModelToolSurface {
    baseTools: readonly AnyDefinedTool[];
    collaborationTools: readonly AnyDefinedTool[];
    collaborationToolsWithoutWorkflows: readonly AnyDefinedTool[];
    imageGenerationSurface: ImageGenerationSurface;
    limitedCollaborationTools: readonly AnyDefinedTool[];
}

const claudeModelToolSurface: ModelToolSurface = {
    baseTools: claudeTools,
    collaborationTools: claudeCollaborationTools,
    collaborationToolsWithoutWorkflows: claudeCollaborationToolsWithoutWorkflows,
    imageGenerationSurface,
    limitedCollaborationTools: claudeLimitedCollaborationTools,
};

const codexV2ModelToolSurface: ModelToolSurface = {
    baseTools: codexTools,
    collaborationTools: codexV2FullCollaborationTools,
    collaborationToolsWithoutWorkflows: codexV2CollaborationTools,
    imageGenerationSurface: codexImageGenerationSurface,
    limitedCollaborationTools: codexV2LimitedCollaborationTools,
};

const codexV1ModelToolSurface: ModelToolSurface = {
    baseTools: codexTools,
    collaborationTools: codexV1FullCollaborationTools,
    collaborationToolsWithoutWorkflows: codexV1CollaborationTools,
    imageGenerationSurface: codexImageGenerationSurface,
    limitedCollaborationTools: codexV1LimitedCollaborationTools,
};

const grokModelToolSurface: ModelToolSurface = {
    baseTools: grokTools,
    collaborationTools: grokCollaborationTools,
    collaborationToolsWithoutWorkflows: grokCollaborationTools,
    imageGenerationSurface,
    limitedCollaborationTools: grokLimitedCollaborationTools,
};

const modelToolSurfaces = new Map<string, ModelToolSurface>([
    ["claude:anthropic/opus-5", claudeModelToolSurface],
    ["claude:anthropic/sonnet-5", claudeModelToolSurface],
    ["claude:anthropic/fable-5", claudeModelToolSurface],
    ["claude:anthropic/opus-4-8", claudeModelToolSurface],
    ["bedrock:anthropic/opus-5", claudeModelToolSurface],
    ["bedrock:anthropic/sonnet-5", claudeModelToolSurface],
    ["bedrock:anthropic/fable-5", claudeModelToolSurface],
    ["bedrock:anthropic/opus-4-8", claudeModelToolSurface],
    ["codex:openai/gpt-5.6-sol", codexV2ModelToolSurface],
    ["codex:openai/gpt-5.6-terra", codexV2ModelToolSurface],
    ["codex:openai/gpt-5.6-luna", codexV1ModelToolSurface],
    ["codex:openai/codex-auto-review", codexV1ModelToolSurface],
    ["bedrock:openai/gpt-5.6-sol", codexV1ModelToolSurface],
    ["bedrock:openai/gpt-5.6-terra", codexV1ModelToolSurface],
    ["bedrock:openai/gpt-5.6-luna", codexV1ModelToolSurface],
    ["bedrock:openai/gpt-5.4", codexV1ModelToolSurface],
    ["grok:xai/grok-build", grokModelToolSurface],
    ["grok:xai/grok-4.5", grokModelToolSurface],
    ["grok:xai/grok-composer-2.5-fast", grokModelToolSurface],
    ["<unspecified>:openai/gym", codexV2ModelToolSurface],
]);

export function modelToolSurface(options: { model: Model; provider: Provider }): ModelToolSurface {
    const providerType = options.provider.type ?? "<unspecified>";
    const key = `${providerType}:${options.model.id}`;
    const surface = modelToolSurfaces.get(key);
    if (surface === undefined) {
        throw new Error(
            `No fixed tool array is configured for model '${options.model.id}' on provider type '${providerType}'.`,
        );
    }
    return surface;
}
