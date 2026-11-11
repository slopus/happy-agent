import type { BotSettings } from "../BotSettings.js";

/** Every way `next` gives a bot's agents more than `previous`, for the Auto reviewer. */
export function describeBotSettingsWidenings(
    previous: BotSettings,
    next: BotSettings,
): readonly string[] {
    const widenings: string[] = [];
    if (previous.allowedSecretIds !== null) {
        if (next.allowedSecretIds === null) {
            widenings.push(
                "removing the secret allowlist, so every secret attached to the bot or where it works becomes usable",
            );
        } else {
            const allowed = new Set(previous.allowedSecretIds);
            const added = next.allowedSecretIds.filter((id) => !allowed.has(id));
            if (added.length > 0) {
                widenings.push(
                    `allowing the ${added.length === 1 ? "secret" : "secrets"} ${added.map((id) => JSON.stringify(id)).join(", ")}`,
                );
            }
        }
    }
    if (!previous.crossWorkspace && next.crossWorkspace) {
        widenings.push(
            "restoring reach to other projects, workspaces, tasks, bots, and agents outside the bot",
        );
    }
    if (previous.compute.type === "docker") {
        if (next.compute.type === "host") {
            widenings.push(
                `moving the bot's commands out of the Docker image ${JSON.stringify(previous.compute.image)} onto the host machine`,
            );
        } else if (next.compute.image !== previous.compute.image) {
            widenings.push(
                `changing the bot's Docker image from ${JSON.stringify(previous.compute.image)} to ${JSON.stringify(next.compute.image)}`,
            );
        }
    }
    return widenings;
}
