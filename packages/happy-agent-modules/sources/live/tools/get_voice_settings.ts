import { defineAgentTool } from "@slopus/happy-agent-base";
import { voiceConfigSchema } from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import type { LiveModule } from "../LiveModule.js";
import { describeVoiceSettings } from "./describeVoiceSettings.js";

export function getVoiceSettingsTool(live: LiveModule, agentId: string) {
    return defineAgentTool({
        name: "get_voice_settings",
        defer: true,
        capabilities: ["Read and change this installation's voice settings."],
        searchKeywords: ["voice", "voice controller", "voice model", "voice prompt", "fast mode"],
        description:
            "Read this Happy Agent installation's voice settings: the stored controller account, model, effort, and fast mode; what a call starting now would actually use and why a setting is ignored; and the voice model's default and effective system prompts. Only active admin bots may use it.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: voiceConfigSchema,
        durable: false,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        autoReview: "never",
        execute: async (ctx) => await live.voiceSettingsForAdmin(ctx, agentId),
        toLLM: (result) => [{ type: "text", text: describeVoiceSettings(result) }],
    });
}
