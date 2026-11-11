import { Type, type Static } from "@sinclair/typebox";
import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { botNameSchema } from "@slopus/happy-agent-client";

import {
    botComputeSettingSchema,
    botSettingsSchema,
    type BotSettings,
    type BotSettingsModule,
    type BotSettingsPatch,
} from "../../botSettings/index.js";
import type { BotsModule } from "../BotsModule.js";

const updateBotSettingsInputSchema = Type.Object(
    {
        botId: cuid2Schema,
        previous: botSettingsSchema,
        allowedSecretIds: Type.Optional(botSettingsSchema.properties.allowedSecretIds),
        crossWorkspace: Type.Optional(Type.Boolean()),
        compute: Type.Optional(botComputeSettingSchema),
    },
    { additionalProperties: false },
);
type UpdateBotSettingsInput = Static<typeof updateBotSettingsInputSchema>;

const updateBotSettingsResultSchema = Type.Object(
    {
        botId: cuid2Schema,
        name: botNameSchema,
        previous: botSettingsSchema,
        settings: botSettingsSchema,
        changed: Type.Boolean(),
    },
    { additionalProperties: false },
);

/**
 * Change what one bot, and every agent working under it, may reach. Admin bots only.
 *
 * The call names the settings it replaces, and the change is applied only while those are still
 * the stored ones. That is what lets the Auto decision rest on the arguments alone: a change that
 * only narrows needs no review, and one that widens is described to the reviewer exactly.
 */
export function updateBotSettingsTool(
    bots: BotsModule,
    botSettings: BotSettingsModule,
    actingAgentId: string,
) {
    const next = (input: UpdateBotSettingsInput): BotSettings =>
        botSettings.merge(input.previous, patchOf(input));
    const widenings = (input: UpdateBotSettingsInput): readonly string[] =>
        botSettings.widenings(input.previous, next(input));
    return defineAgentTool({
        name: "update_bot_settings",
        defer: true,
        capabilities: ["Read and change what each bot and the agents under it may reach."],
        searchKeywords: [
            "bot settings",
            "restrict bot",
            "lock down bot",
            "bot docker",
            "bot secrets",
        ],
        description: [
            "Change one bot's settings. They govern the bot's agent and every agent working under it: its subtasks, their collaborators, its exported-bot conversations, and tasks it creates. Only active admin bots may use it.",
            "Pass previous exactly as get_bot_settings returned it, then only the fields to change:",
            "- allowedSecretIds: null lets them use any secret attached to the bot or where it works; an array of secret IDs is the complete set they may list, attach, update, and select for commands, and [] allows none. With an array they cannot create secrets.",
            "- crossWorkspace: false keeps them to the bot's own agents, with no projects, workspaces, tasks, other bots, or agents outside the bot; true leaves reach to this installation's setting.",
            '- compute: {"type":"host"} runs them on the machine holding the bot\'s folder; {"type":"docker","image":"..."} runs their files and commands in a container of that image with only their own folder mounted, where commands cannot select secrets. A compute change reaches new agents at once and running agents after Happy Agent restarts.',
            "A change that only narrows is applied directly; one that widens access is reviewed first.",
        ].join("\n"),
        parameters: updateBotSettingsInputSchema,
        returnType: updateBotSettingsResultSchema,
        durable: true,
        transactional: true,
        requiresAutoOrFullAccess: true,
        autoPermissionInstructions:
            "Changing a bot's settings changes what that bot and every agent working under it can reach. A change that widens secrets, reach, or compute isolation is reviewed; one that only narrows is not.",
        shouldReviewInAutoMode: (input: UpdateBotSettingsInput) => widenings(input).length > 0,
        describeAutoPermissionAction: (input: UpdateBotSettingsInput) => {
            const widened = widenings(input);
            return widened.length === 0
                ? `narrowing the settings of bot ${JSON.stringify(input.botId)}`
                : `widening the settings of bot ${JSON.stringify(input.botId)}, which governs the bot's agent and every agent working under it: ${widened.join("; ")}`;
        },
        execute: async (ctx, input: UpdateBotSettingsInput) =>
            await bots.updateSettingsForAgent(
                ctx,
                actingAgentId,
                input.botId,
                input.previous,
                patchOf(input),
            ),
        toLLM: ({ botId, name, settings, changed }) => [
            {
                type: "text",
                text: `${changed ? "Updated" : "Nothing changed in"} the settings of bot ${JSON.stringify(name)} (${botId}):\n${botSettings.describe(settings)}`,
            },
        ],
    });
}

function patchOf(input: UpdateBotSettingsInput): BotSettingsPatch {
    const patch: { -readonly [Key in keyof BotSettingsPatch]: BotSettingsPatch[Key] } = {};
    if (input.allowedSecretIds !== undefined) patch.allowedSecretIds = input.allowedSecretIds;
    if (input.crossWorkspace !== undefined) patch.crossWorkspace = input.crossWorkspace;
    if (input.compute !== undefined) patch.compute = input.compute;
    if (Object.keys(patch).length === 0) {
        throw new Error(
            "Name at least one setting to change: allowedSecretIds, crossWorkspace, or compute.",
        );
    }
    return patch;
}
