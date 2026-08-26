import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { BotAvatarInputError } from "../BotAvatarInputError.js";
import type { BotsModule } from "../BotsModule.js";
import { MAX_BOT_AVATAR_BYTES } from "../impl/normalizeBotAvatar.js";

const setBotAvatarInputSchema = Type.Object(
    {
        path: Type.String({ minLength: 1, maxLength: 4_096 }),
    },
    { additionalProperties: false },
);
type SetBotAvatarInput = Static<typeof setBotAvatarInputSchema>;

/** Let a bot choose its own picture from an image file in its folder. */
export function setBotAvatarTool(bots: BotsModule, botAgentId: string) {
    return defineAgentTool({
        name: "set_bot_avatar",
        defer: true,
        capabilities: ["Choose this bot's own avatar picture."],
        searchKeywords: ["bot avatar", "profile picture", "set my picture"],
        description:
            "Set your own avatar from an image file in your folder. Give the path to a PNG, JPEG, or WebP image, up to 8 MiB; write or generate the image first, then point this tool at it. The picture is resized to a square-fitting WebP and shown wherever you appear.",
        parameters: setBotAvatarInputSchema,
        returnType: Type.Void(),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: SetBotAvatarInput) => {
            const bot = await bots.forAgent(ctx, botAgentId);
            if (bot === undefined) throw new Error("Only a bot can set its own avatar.");
            const bytes = await readImageWithin(bot.path, input.path);
            await bots.setOwnAvatar(ctx, botAgentId, bytes);
        },
        toLLM: () => [
            {
                type: "text",
                text: "Your avatar is set.",
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
