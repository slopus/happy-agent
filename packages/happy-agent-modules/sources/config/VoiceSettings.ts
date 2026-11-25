import { Type, type Static } from "@sinclair/typebox";

/** The controller model a voice call uses when the settings name none. */
export const VOICE_CONTROLLER_DEFAULT_MODEL = "openai/gpt-6.2-sol";

/** The controller's speed, named as the model picker names it; Regular is the ordinary tier. */
export const voiceSpeedSchema = Type.Union([
    Type.Literal("regular"),
    Type.Literal("fast"),
    Type.Literal("ultrafast"),
]);
export type VoiceSpeed = Static<typeof voiceSpeedSchema>;

const providerId = Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" });
const modelId = Type.String({ minLength: 1, maxLength: 256, pattern: "\\S" });
const effort = Type.String({ minLength: 1, maxLength: 32, pattern: "\\S" });
const systemPrompt = Type.String({ minLength: 1, maxLength: 32_768, pattern: "\\S" });
const nullable = <
    T extends
        | ReturnType<typeof Type.String>
        | ReturnType<typeof Type.Boolean>
        | typeof voiceSpeedSchema,
>(
    schema: T,
) => Type.Optional(Type.Union([schema, Type.Null()]));

/** The `[voice]` table of machine configuration and generated runtime configuration. */
export const voiceSettingsTomlSchema = Type.Object(
    {
        controller_provider: Type.Optional(providerId),
        controller_model: Type.Optional(modelId),
        controller_effort: Type.Optional(effort),
        /** Kept for compatibility; `controller_speed` wins when both are stored. */
        controller_fast_mode: Type.Optional(Type.Boolean()),
        controller_speed: Type.Optional(voiceSpeedSchema),
        system_prompt: Type.Optional(systemPrompt),
    },
    { additionalProperties: false },
);
export type VoiceSettingsToml = Static<typeof voiceSettingsTomlSchema>;

/** A runtime change: an omitted key is unchanged and `null` removes the stored value. */
export const voiceSettingsUpdateSchema = Type.Object(
    {
        controller_provider: nullable(providerId),
        controller_model: nullable(modelId),
        controller_effort: nullable(effort),
        controller_fast_mode: nullable(Type.Boolean()),
        controller_speed: nullable(voiceSpeedSchema),
        system_prompt: nullable(systemPrompt),
    },
    { additionalProperties: false },
);
export type VoiceSettingsUpdate = Static<typeof voiceSettingsUpdateSchema>;

/** A proven, human-readable reason a voice settings change was refused. */
export class VoiceSettingsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "VoiceSettingsError";
    }
}
