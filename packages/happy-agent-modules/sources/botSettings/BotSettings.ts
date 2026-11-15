import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

const exact = { additionalProperties: false } as const;

/** An installation-wide secret name, as the secrets catalog writes it. */
export const botSettingsSecretIdSchema = Type.String({
    minLength: 2,
    maxLength: 32,
    pattern: "^[a-z][a-z0-9_-]*$",
});

/** The most secrets one allowlist may name. */
export const MAX_BOT_ALLOWED_SECRETS = 256;

/** A Docker image reference: printable, without whitespace or control characters. */
export const botDockerImageSchema = Type.String({
    minLength: 1,
    maxLength: 512,
    pattern: "^[^\\u0000-\\u0020\\u007f]+$",
});

/** Where the agents a bot governs run their files and commands. */
export const botComputeSettingSchema = Type.Union([
    Type.Object({ type: Type.Literal("host") }, exact),
    Type.Object({ type: Type.Literal("docker"), image: botDockerImageSchema }, exact),
]);

/**
 * The owner's restrictions on one bot. They govern the bot's agent and every agent working under
 * it, and every owning module enforces them; none of them is an instruction to the model.
 */
export const botSettingsSchema = Type.Object(
    {
        /** `null` restricts nothing; an array is the complete set of usable secrets. */
        allowedSecretIds: Type.Union([
            Type.Array(botSettingsSecretIdSchema, {
                maxItems: MAX_BOT_ALLOWED_SECRETS,
                uniqueItems: true,
            }),
            Type.Null(),
        ]),
        /** `false` confines governed agents to the bot's own agents. It never widens reach. */
        crossWorkspace: Type.Boolean(),
        compute: botComputeSettingSchema,
    },
    exact,
);

/** A partial change; omitted fields keep their current values. */
export const botSettingsPatchSchema = Type.Object(
    {
        allowedSecretIds: Type.Optional(botSettingsSchema.properties.allowedSecretIds),
        crossWorkspace: Type.Optional(Type.Boolean()),
        compute: Type.Optional(botComputeSettingSchema),
    },
    { ...exact, minProperties: 1 },
);

export type BotSettings = Static<typeof botSettingsSchema>;
export type BotSettingsPatch = Static<typeof botSettingsPatchSchema>;
export type BotComputeSetting = Static<typeof botComputeSettingSchema>;

/** What a bot nobody has configured runs with: exactly the behavior before bot settings. */
export const DEFAULT_BOT_SETTINGS: BotSettings = Object.freeze({
    allowedSecretIds: null,
    crossWorkspace: true,
    compute: Object.freeze({ type: "host" as const }),
}) as BotSettings;

/** The bot settings in force for one agent, and the bot agent whose settings they are. */
export interface BotSettingsGovernance {
    /** The governing bot's own agent. Every agent it governs resolves to this same ID. */
    readonly botAgentId: string;
    readonly settings: BotSettings;
}

export const botSettingsEventSchema = Type.Object(
    {
        type: Type.Literal("bot_settings_updated"),
        eventId: Type.String({ minLength: 1, maxLength: 128 }),
        at: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        botAgentId: Type.String({ minLength: 1, maxLength: 128 }),
        previous: botSettingsSchema,
        settings: botSettingsSchema,
    },
    exact,
);

export type BotSettingsEvent = Static<typeof botSettingsEventSchema>;
export type BotSettingsEventListener = (
    ctx: Context,
    event: BotSettingsEvent,
) => Promise<void> | void;
export type BotSettingsUnsubscribe = () => void;

export class BotSettingsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BotSettingsError";
    }
}
