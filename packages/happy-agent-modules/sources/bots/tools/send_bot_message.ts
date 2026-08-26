import { Type, type Static } from "@sinclair/typebox";
import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";

import type { BotsModule } from "../BotsModule.js";

const sendBotMessageInputSchema = Type.Object(
    {
        botId: cuid2Schema,
        text: Type.String({ minLength: 1, maxLength: 100_000 }),
    },
    { additionalProperties: false },
);
type SendBotMessageInput = Static<typeof sendBotMessageInputSchema>;

/** Deliver one message into a bot's continuous conversation. */
export function sendBotMessageTool(bots: BotsModule, actingAgentId: string) {
    return defineAgentTool({
        name: "send_bot_message",
        defer: true,
        capabilities: ["List, create, and message persistent bots."],
        searchKeywords: ["message bot", "talk to assistant", "bot conversation"],
        description: [
            "Send a message to a bot by its ID. Find IDs with list_bots.",
            "",
            "The message joins the bot's one continuous conversation: an idle bot starts working on it immediately, and a busy bot picks it up when its current work ends. Delivery returns right away; the bot's answer arrives as a message when it has one, so carry on with other work in the meantime.",
        ].join("\n"),
        parameters: sendBotMessageInputSchema,
        returnType: Type.Void(),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: SendBotMessageInput, call) => {
            await bots.sendMessage(ctx, actingAgentId, input.botId, input.text, call.id);
        },
        toLLM: () => [
            {
                type: "text",
                text: "Message delivered to the bot. Any answer arrives as a message; carry on with other work in the meantime.",
            },
        ],
    });
}
