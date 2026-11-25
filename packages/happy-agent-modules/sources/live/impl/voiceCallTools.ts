import { defineAgentTool, type AnyAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import type { LiveModule } from "../LiveModule.js";

const resultSchema = Type.Object({ text: Type.String() }, { additionalProperties: false });

/**
 * The call itself, as the phones' agent can end it: hanging up is what the person does with End,
 * so it needs no review, and it is never durable, because a restart already ends the call.
 */
export function voiceCallTools(live: LiveModule, agentId: string): AnyAgentTool[] {
    return [
        defineAgentTool({
            name: "end_call",
            defer: false,
            capabilities: ["End the voice call when the person asks to hang up."],
            description:
                "End the voice call this request came from, as the person's End button does. Use it only when the person asked to hang up or end the call; voice has already said goodbye, and nothing more is spoken.",
            parameters: Type.Object({}, { additionalProperties: false }),
            returnType: resultSchema,
            durable: false,
            shouldReviewInAutoMode: () => false,
            autoReview: "never",
            execute: async () => ({ text: live.endVoiceCall(agentId) }),
            toLLM: (result) => [{ type: "text", text: result.text }],
        }),
    ];
}
