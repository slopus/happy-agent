import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { happyBotIdSchema, exportedBotStatusListSchema } from "../ExportedBot.js";
import type { ExportedBotsModule } from "../ExportedBotsModule.js";
import { formatExportedBotStatus } from "./formatExportedBotStatus.js";

const getExportedBotStatusInputSchema = Type.Object(
    { botId: Type.Optional(happyBotIdSchema) },
    { additionalProperties: false },
);
type GetExportedBotStatusInput = Static<typeof getExportedBotStatusInputSchema>;

/** Read every export's live state. Only active admin bots receive this tool. */
export function getExportedBotStatusTool(exportedBots: ExportedBotsModule, actingAgentId: string) {
    return defineAgentTool({
        name: "get_exported_bot_status",
        defer: true,
        capabilities: [
            "Export bots to Telegram or other chat services and choose who may talk to them.",
        ],
        searchKeywords: [
            "exported bot status",
            "Telegram bot status",
            "exported bot allowlist",
            "Telegram user ID",
            "bridge status",
        ],
        description:
            "Read how bots are exported to chat services such as Telegram: whether each export is connected and as which account, who is allowed, each guest's conversation subtask, who is waiting to be let in, and who was recently turned away or ignored. Approve or deny someone waiting with approve_exported_bot_user or deny_exported_bot_user once the user decides. What people outside the allowlist wrote is never shown, and neither are credentials. botId limits the answer to one bot's exports; without it, every export is listed.",
        parameters: getExportedBotStatusInputSchema,
        returnType: exportedBotStatusListSchema,
        durable: false,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        autoReview: "never",
        execute: async (ctx, input: GetExportedBotStatusInput) =>
            await exportedBots.status(ctx, actingAgentId, input.botId),
        toLLM: (status) => [{ type: "text", text: formatExportedBotStatus(status) }],
    });
}
