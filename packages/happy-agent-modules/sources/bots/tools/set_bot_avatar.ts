import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";

import { BotNotFoundError } from "../Bot.js";
import { BotAvatarInputError } from "../BotAvatarInputError.js";
import type { BotsModule } from "../BotsModule.js";
import { formatOtherBotRefusal } from "../impl/formatOtherBotRefusal.js";
import { MAX_MANAGED_IMAGE_BYTES as MAX_BOT_AVATAR_BYTES } from "../../impl/images/normalizeManagedImage.js";

const setBotAvatarInputSchema = Type.Object(
    {
        path: Type.String({ minLength: 1, maxLength: 4_096 }),
        botId: Type.Optional(cuid2Schema),
    },
    { additionalProperties: false },
);
type SetBotAvatarInput = Static<typeof setBotAvatarInputSchema>;

/** Let a bot choose its own picture, or an admin choose any bot's picture. */
export function setBotAvatarTool(bots: BotsModule, botAgentId: string) {
    return defineAgentTool({
        name: "set_bot_avatar",
        defer: true,
        capabilities: ["Choose bot avatar pictures; admin bots can update any bot."],
        searchKeywords: ["bot avatar", "profile picture", "set my picture", "admin bot avatar"],
        description:
            "Set a bot's avatar from an image file in your own folder. Omit botId, or pass your own bot ID, to set your own picture. Only active admin bots may supply another bot's ID, including an archived bot's; find IDs and missing avatars with list_bots. Give the path to a PNG, JPEG, or WebP image, up to 8 MiB; write or generate the image first, then point this tool at it. The picture is resized to a square-fitting WebP.",
        parameters: setBotAvatarInputSchema,
        returnType: Type.Void(),
        durable: true,
        shouldReviewInAutoMode: () => false,
        autoReview: "never",
        execute: async (ctx, input: SetBotAvatarInput) => {
            const bot = await bots.forAgent(ctx, botAgentId);
            if (bot === undefined) throw new Error("Only a bot can set its own avatar.");
            if (bot.status === "archived") {
                throw new Error("An archived bot cannot change avatars.");
            }
            if (input.botId !== undefined && input.botId !== bot.id) {
                if (!bot.isAdmin) {
                    throw new Error(
                        formatOtherBotRefusal(
                            "set another bot's avatar",
                            "set your own picture",
                            await bots.list(ctx),
                        ),
                    );
                }
                if ((await bots.get(ctx, input.botId)) === undefined) {
                    throw new BotNotFoundError(
                        `There is no bot with ID ${input.botId}. Find bot IDs with list_bots.`,
                    );
                }
            }
            const bytes = await readImageWithin(bot.path, input.path);
            await bots.setAvatarForAgent(ctx, botAgentId, bytes, input.botId);
        },
        toLLM: () => [
            {
                type: "text",
                text: "The bot's avatar is set.",
            },
        ],
    });
}

/** Reads the image while refusing paths and symlinks that leave the bot's folder. */
async function readImageWithin(botFolder: string, requested: string): Promise<Uint8Array> {
    const candidate = isAbsolute(requested) ? requested : resolve(botFolder, requested);
    const folder = await realpath(botFolder);
    const target = await realpath(candidate).catch(() => undefined);
    if (target === undefined) {
        throw new BotAvatarInputError(`There is no image at ${requested}.`);
    }
    if (target !== folder && !target.startsWith(folder + sep)) {
        throw new BotAvatarInputError("The avatar image must live inside your own folder.");
    }
    const facts = await stat(target);
    if (!facts.isFile()) {
        throw new BotAvatarInputError("The avatar path must name an image file.");
    }
    if (facts.size === 0 || facts.size > MAX_BOT_AVATAR_BYTES) {
        throw new BotAvatarInputError("The avatar image must be no larger than 8 MiB.");
    }
    return new Uint8Array(await readFile(target));
}
