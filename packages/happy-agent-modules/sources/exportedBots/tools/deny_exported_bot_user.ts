import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    exportedBotUserInputSchema,
    deniedExportedBotUserSchema,
    type ExportedBotUserInput,
} from "../ExportedBot.js";
import type { ExportedBotsModule } from "../ExportedBotsModule.js";

/**
 * Turn one person away from an exported bot. It only ever takes access away, so it is not
 * reviewed. Only active admin bots receive this tool.
 */
export function denyExportedBotUserTool(exportedBots: ExportedBotsModule, actingAgentId: string) {
    return defineAgentTool({
        name: "deny_exported_bot_user",
        defer: true,
        capabilities: [
            "Export bots to Telegram or other chat services and choose who may talk to them.",
        ],
        searchKeywords: [
            "deny exported bot access request",
            "block Telegram user",
            "decline access request",
        ],
        description:
            'Turn one person away from an exported bot, after they asked and the user said no. kind is how the bot is exported, "telegram" or "bridge"; botId is the exported bot; userId is the person\'s ID on that service. Use the values the access request named. The message they were waiting with is discarded, they are taken off the allowlist if they were on it, and nothing they send is answered or shown to anyone until someone approves them. They are not told. A guest they already were stays, so earlier messages keep their author.',
        parameters: exportedBotUserInputSchema,
        returnType: deniedExportedBotUserSchema,
        durable: true,
        // The same access as approving, but taking access away needs no review.
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => false,
        autoReview: "never",
        execute: async (ctx, input: ExportedBotUserInput) =>
            await exportedBots.denyUser(ctx, actingAgentId, input),
        toLLM: (denied) => [
            {
                type: "text",
                text: [
                    `Turned away ${denied.service} user ${denied.userId} from ${denied.bot}.`,
                    denied.wasAllowed ? "They were taken off the allowlist." : undefined,
                    denied.discarded
                        ? "The message they were waiting with was discarded."
                        : undefined,
                    "Their later messages go nowhere until someone approves them.",
                ]
                    .filter((part) => part !== undefined)
                    .join(" "),
            },
        ],
    });
}
