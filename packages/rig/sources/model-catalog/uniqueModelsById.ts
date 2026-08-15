import type { Model } from "@slopus/happy-agent-base";

export function uniqueModelsById(models: readonly Model[]): readonly Model[] {
    return [...new Map(models.map((model) => [model.id, model])).values()];
}
