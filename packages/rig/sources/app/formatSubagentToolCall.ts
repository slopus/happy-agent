import type { Model } from "../protocol/index.js";
import type { CodingAssistantModelChoice } from "./CodingAssistantAgentBackend.js";

export function formatSubagentToolCall(options: {
    args: Readonly<Record<string, unknown>>;
    currentModel: Model;
    currentProviderId: string;
    modelChoices: readonly CodingAssistantModelChoice[];
    resolvedModelId?: string;
    toolName: string;
}): string | undefined {
    const normalized = options.toolName.toLowerCase();
    const description = (() => {
        if (normalized === "agent" || normalized === "spawn_subagent") {
            const value = options.args.description;
            return typeof value === "string" && value.trim().length > 0
                ? value.trim()
                : "Delegated work";
        }
        if (normalized === "spawn_agent") {
            const value = options.args.task_name;
            return typeof value === "string" && value.length > 0
                ? value.replaceAll("_", " ").replace(/^./u, (character) => character.toUpperCase())
                : "Start delegated work";
        }
        return undefined;
    })();
    if (description === undefined) return undefined;

    const requestedModelId =
        typeof options.args.model === "string" && options.args.model.length > 0
            ? options.args.model
            : undefined;
    const requestedProviderId =
        typeof options.args.provider === "string" && options.args.provider.length > 0
            ? options.args.provider
            : undefined;
    const selectedModelId = options.resolvedModelId ?? requestedModelId;
    const model =
        selectedModelId === undefined
            ? options.currentModel
            : (options.modelChoices.find(
                  (choice) =>
                      choice.model.id === selectedModelId &&
                      choice.providerId === (requestedProviderId ?? options.currentProviderId),
              )?.model ??
              (() => {
                  const matches = options.modelChoices.filter(
                      (choice) => choice.model.id === selectedModelId,
                  );
                  return matches.length === 1 ? matches[0]?.model : undefined;
              })());
    const modelName =
        model?.name ??
        (selectedModelId ?? options.currentModel.id)
            .split("/")
            .at(-1)
            ?.replaceAll(/[-_]+/gu, " ")
            .replace(/\b\p{L}/gu, (character) => character.toUpperCase()) ??
        "Unknown model";
    return `${description} · ${modelName}`;
}
