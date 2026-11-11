import { Type, type Static } from "@sinclair/typebox";
import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { botNameSchema } from "@slopus/happy-agent-client";

import { botSettingsSchema, type BotSettingsModule } from "../../botSettings/index.js";
import type { BotsModule } from "../BotsModule.js";

const getBotSettingsInputSchema = Type.Object(
    { botId: cuid2Schema },
    { additionalProperties: false },
);
type GetBotSettingsInput = Static<typeof getBotSettingsInputSchema>;

export const botSettingsToolResultSchema = Type.Object(
    { botId: cuid2Schema, name: botNameSchema, settings: botSettingsSchema },
    { additionalProperties: false },
);

/** Read what one bot, and every agent working under it, may reach. Admin bots only. */
export function getBotSettingsTool(
    bots: BotsModule,
    botSettings: BotSettingsModule,
    actingAgentId: string,
) {
    return defineAgentTool({
        name: "get_bot_settings",
        defer: true,
        capabilities: ["Read and change what each bot and the agents under it may reach."],
        searchKeywords: ["bot settings", "restrict bot", "bot permissions", "lock down bot"],
        description:
            "Read one bot's settings: which secrets it and every agent under it may use, whether they may reach other projects, workspaces, tasks, bots, and agents, and where their commands run. Find bot IDs with list_bots. Only active admin bots may use it. Pass the returned settings unchanged as previous to update_bot_settings.",
        parameters: getBotSettingsInputSchema,
        returnType: botSettingsToolResultSchema,
        durable: true,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        autoReview: "never",
        execute: async (ctx, { botId }: GetBotSettingsInput) =>
            await bots.settingsForAgent(ctx, actingAgentId, botId),
        toLLM: ({ botId, name, settings }) => [
            {
                type: "text",
                text: `Settings of bot ${JSON.stringify(name)} (${botId}):\n${botSettings.describe(settings)}\nCurrent value, to pass as previous: ${JSON.stringify(settings)}`,
            },
        ],
    });
}
