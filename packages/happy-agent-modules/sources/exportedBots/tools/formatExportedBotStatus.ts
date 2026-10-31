import type { ExportedBotStatus, ExportedBotStatusList } from "../ExportedBot.js";

const STATE_TEXT = {
    disabled: "is turned off",
    waiting_for_bot: "is waiting for its bot",
    connecting: "is connecting",
    waiting_for_bridge: "is waiting for its bridge to connect",
    connected: "is connected",
    failed: "is not working",
} as const;

/** One bounded, human-readable rendering of every export's status. Credentials are never in it. */
export function formatExportedBotStatus(status: ExportedBotStatusList): string {
    if (status.exportedBots.length === 0) {
        return status.botId === undefined
            ? "No bot is exported yet."
            : "That bot is not exported yet.";
    }
    return status.exportedBots.map(formatOne).join("\n\n");
}

function formatOne(exportedBot: ExportedBotStatus): string {
    const { service } = exportedBot;
    const account =
        exportedBot.serviceUsername === undefined
            ? ""
            : ` (${service} bot @${exportedBot.serviceUsername}${exportedBot.link === undefined ? "" : `, ${exportedBot.link}`})`;
    const lines = [
        `The ${service} export of bot ${exportedBot.bot ?? exportedBot.botId} ${STATE_TEXT[exportedBot.state]}${account}.`,
    ];
    if (exportedBot.error !== undefined) lines.push(`Problem: ${exportedBot.error}`);
    lines.push(
        exportedBot.allowedUsers.length === 0
            ? `Allowed ${service} user IDs: none yet.`
            : `Allowed ${service} user IDs: ${exportedBot.allowedUsers.join(", ")}.`,
    );
    for (const conversation of exportedBot.conversations) {
        lines.push(
            `Conversation with ${conversation.name} (${conversation.userId}): subtask ${conversation.agentId}.`,
        );
    }
    lines.push(
        exportedBot.unknownSenders === "ask"
            ? "People not on the allowlist are asked about: their first message is held while the Chief of Staff asks whether to let them in."
            : "People not on the allowlist are ignored.",
    );
    for (const request of exportedBot.accessRequests) {
        lines.push(
            `Waiting to be let in since ${new Date(request.at).toISOString()}: ${request.name}${request.username === undefined ? "" : ` (@${request.username})`}, ${service} user ${request.userId}.`,
        );
    }
    if (exportedBot.deniedUsers.length > 0) {
        lines.push(
            `Recently turned away ${service} user IDs: ${exportedBot.deniedUsers.map((user) => user.userId).join(", ")}.`,
        );
    }
    for (const sender of exportedBot.ignoredSenders) {
        lines.push(
            `Ignored a message from ${service} user ${sender.userId}${sender.username === undefined ? "" : ` (@${sender.username})`} at ${new Date(sender.at).toISOString()}; they are not on the allowlist.`,
        );
    }
    return lines.join("\n");
}
