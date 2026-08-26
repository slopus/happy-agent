import type { AgentEnvironment } from "@slopus/happy-agent-base";

import type { SystemPromptAvailableModel } from "../SystemPromptAvailableModel.js";

/** Render the heading and every configured provider/model route. */
export function formatAvailableModels(
    availableModels: readonly SystemPromptAvailableModel[],
): string {
    if (availableModels.length === 0) return "";
    return [
        "## Available models",
        ...availableModels.map(
            (model) =>
                `- ${model.name} — model ID: \`${model.id}\`; provider ID: \`${model.providerId}\``,
        ),
    ].join("\n");
}

/** Render the machine guidance and configured model routes appended to a vendor prompt. */
export function assembleEnvironmentPrompt(options: {
    environment: AgentEnvironment;
    availableModels: readonly SystemPromptAvailableModel[];
    currentModel: string | undefined;
    currentProvider: string;
    designSystemPath: string;
    documentationPath: string;
}): string {
    const { currentModel, currentProvider, environment } = options;
    const shell = environment.shell.trim();
    const catalogEntry =
        currentModel === undefined
            ? undefined
            : (options.availableModels.find(
                  (model) => model.id === currentModel && model.providerId === currentProvider,
              ) ?? options.availableModels.find((model) => model.id === currentModel));
    const currentModelLine =
        currentModel === undefined
            ? undefined
            : catalogEntry === undefined
              ? `- Current model: \`${currentModel}\``
              : `- Current model: ${catalogEntry.name} (\`${currentModel}\`)`;
    return [
        "# Environment",
        `- Primary working directory: ${environment.workingDirectory}`,
        `- Platform: ${environment.platform}`,
        ...(shell.length === 0 ? [] : [`- Shell: ${shell}`]),
        `- OS version: ${environment.osVersion}`,
        ...(currentModelLine === undefined ? [] : [currentModelLine]),
        `- Current provider: \`${currentProvider}\``,
        `- Happy Agent documentation: ${options.documentationPath}`,
        `- Happy design system: When the user asks for a temporary page unrelated to their work, or asks to use the Happy design system, read and follow ${options.designSystemPath}.`,
        "- Scratch directory: `.context/` in the working directory. Strongly prefer it for temporary files, throwaway scripts, and notes or instructions for other agents; keep it gitignored (add the entry if missing) unless there is a real reason not to, and never commit it.",
        "- By default the user sees only the last message you send before stopping; earlier messages are collapsed. Include all essential information in that last message.",
        "- When the project is a Git folder, a workspace and a worktree are the same thing: creating a workspace creates a new worktree, and deleting a workspace archives it.",
        ...(options.availableModels.length === 0
            ? []
            : ["", formatAvailableModels(options.availableModels)]),
    ].join("\n");
}
