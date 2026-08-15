import type { AnyDefinedTool } from "../agent/types.js";
import type { Model, Provider } from "@slopus/rig-execution";
import {
    createImageGenerationTool,
    type ImageGenerationProvider,
} from "../tools/imageGeneration/createImageGenerationTool.js";
import { modelToolSurface } from "./modelToolSurface.js";

export interface SelectToolsForModelOptions {
    imageGeneration?: readonly ImageGenerationProvider[];
    provider: Provider;
    model: Model;
}

export function selectToolsForModel(
    options: SelectToolsForModelOptions,
): readonly AnyDefinedTool[] {
    const surface = modelToolSurface(options);
    const vendorTools = surface.baseTools;
    return [
        ...vendorTools,
        ...imageGenerationTools(options.imageGeneration ?? [], surface.imageGenerationSurface),
    ] as readonly AnyDefinedTool[];
}

function imageGenerationTools(
    providers: readonly ImageGenerationProvider[],
    surface: Parameters<typeof createImageGenerationTool>[1],
): readonly AnyDefinedTool[] {
    if (providers.length === 0) return [];
    return [createImageGenerationTool(providers, surface)];
}
