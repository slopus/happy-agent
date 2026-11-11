import type { BotSettings } from "../BotSettings.js";

/** One bot's settings, a line per setting, for the owner deciding what to change. */
export function formatBotSettings(settings: BotSettings): string {
    const secrets =
        settings.allowedSecretIds === null
            ? "Secrets: any secret attached to the bot or where it works."
            : settings.allowedSecretIds.length === 0
              ? "Secrets: none."
              : `Secrets: only ${settings.allowedSecretIds.map((id) => JSON.stringify(id)).join(", ")}.`;
    const reach = settings.crossWorkspace
        ? "Reach: other projects, workspaces, and agents, as far as this installation allows."
        : "Reach: only the bot's own agents.";
    const compute =
        settings.compute.type === "host"
            ? "Compute: the machine holding the bot's folder, under the ordinary sandbox."
            : `Compute: a Docker container of ${JSON.stringify(settings.compute.image)} with only each agent's folder mounted.`;
    return [secrets, reach, compute].join("\n");
}
