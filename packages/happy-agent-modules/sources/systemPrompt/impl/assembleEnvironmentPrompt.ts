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
    // Native Compute always selects Windows PowerShell, independent of SHELL. Older agent
    // configurations captured an empty value or Git Bash from the launching terminal instead.
    const shell =
        environment.platform === "win32"
            ? "Windows PowerShell 5.1 (powershell.exe)"
            : environment.shell.trim();
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
        ...(environment.platform === "win32"
            ? [
                  "- Commands run on native Windows in the listed shell, including calls named Bash. Use native Windows tools and paths. WSL and Git Bash are separate environments; use them only when the task calls for them.",
                  "- Use PowerShell syntax: $env:NAME = 'value' for environment variables; & 'C:\\Program Files\\tool.exe' for a quoted executable; -LiteralPath for file operations. Separate commands with newlines. PowerShell 5.1 does not support &&, ||, export, or Bash heredocs. Check $LASTEXITCODE after native programs before continuing dependent work.",
                  "- Start background helpers with Start-Process -WindowStyle Hidden unless the user needs a visible window. Keep filesystem operations in one shell and verify the resolved target before recursive deletion or moving files.",
              ]
            : []),
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
