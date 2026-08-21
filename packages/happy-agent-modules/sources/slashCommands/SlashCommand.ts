import { Type, type Static } from "@sinclair/typebox";
import type { AgentModule } from "@slopus/happy-agent-base";
import {
    MAX_SLASH_COMMAND_ARGUMENTS_LENGTH,
    MAX_SLASH_COMMAND_DESCRIPTION_LENGTH,
    MAX_SLASH_COMMAND_IMAGE_THUMBHASH_LENGTH,
    MAX_SLASH_COMMAND_KIND_LENGTH,
    MAX_SLASH_COMMAND_NAME_LENGTH,
    invokeSlashCommandRequestSchema,
    slashCommandCatalogSchema,
    type InvokeSlashCommandRequest,
    type SlashCommand,
} from "@slopus/happy-agent-client";
import type { Context } from "@steve.kite/stdlib";

export const MAX_SLASH_COMMAND_IMAGE_BYTES = 8 * 1024 * 1024;

export const slashCommandImageContentSchema = Type.Object(
    {
        blob: Type.Uint8Array({ minByteLength: 1, maxByteLength: MAX_SLASH_COMMAND_IMAGE_BYTES }),
        mediaType: Type.Union([
            Type.Literal("image/jpeg"),
            Type.Literal("image/png"),
            Type.Literal("image/webp"),
        ]),
        thumbhash: Type.String({
            minLength: 1,
            maxLength: MAX_SLASH_COMMAND_IMAGE_THUMBHASH_LENGTH,
        }),
    },
    { additionalProperties: false },
);

export const slashCommandDefinitionSchema = Type.Object(
    {
        description: Type.String({
            minLength: 1,
            maxLength: MAX_SLASH_COMMAND_DESCRIPTION_LENGTH,
        }),
        hasArguments: Type.Boolean(),
        image: Type.Optional(slashCommandImageContentSchema),
        kind: Type.Optional(
            Type.String({ minLength: 1, maxLength: MAX_SLASH_COMMAND_KIND_LENGTH }),
        ),
        name: Type.String({
            minLength: 1,
            maxLength: MAX_SLASH_COMMAND_NAME_LENGTH,
            pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
        }),
    },
    { additionalProperties: false },
);

export const slashCommandCatalogEventPayloadSchema = Type.Object(
    { slashCommands: slashCommandCatalogSchema },
    { additionalProperties: false },
);

export const slashCommandInvocationSchema = Type.Object(
    {
        arguments: Type.Optional(Type.String({ maxLength: MAX_SLASH_COMMAND_ARGUMENTS_LENGTH })),
        mode: invokeSlashCommandRequestSchema.properties.mode,
        mutationId: Type.Optional(invokeSlashCommandRequestSchema.properties.mutationId),
    },
    { additionalProperties: false },
);

export type SlashCommandImageContent = Static<typeof slashCommandImageContentSchema>;
export type SlashCommandDefinition = Static<typeof slashCommandDefinitionSchema>;
export type SlashCommandCatalogEventPayload = Static<typeof slashCommandCatalogEventPayloadSchema>;
export type SlashCommandInvocation = Static<typeof slashCommandInvocationSchema>;

/** A module that owns commands and receives their direct invocations. */
export interface SlashCommandContributor extends AgentModule {
    slashCommands(ctx: Context, agentId: string): Promise<readonly SlashCommandDefinition[]>;
    invokeSlashCommand(
        ctx: Context,
        agentId: string,
        name: string,
        input: InvokeSlashCommandRequest,
    ): Promise<void>;
}

export interface SlashCommandImageAsset {
    readonly blob: Uint8Array;
    readonly etag: string;
    readonly mediaType: SlashCommandImageContent["mediaType"];
}

export interface SlashCommandInvocationResult {
    readonly command: SlashCommand;
    readonly slashCommands: SlashCommand[];
}

export class SlashCommandNotFoundError extends Error {}
export class SlashCommandInputError extends Error {}
