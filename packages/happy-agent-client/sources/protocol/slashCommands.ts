/** Slash commands contributed by agent modules and invoked through the focused agent API. */

import { type Static, Type } from "@sinclair/typebox";

import { messageModeSchema, mutationIdSchema, type EventCursor } from "./common.js";
import type { Agent, AgentProfileCatalog } from "./agents.js";

export const MAX_SLASH_COMMANDS = 256;
export const MAX_SLASH_COMMAND_NAME_LENGTH = 128;
export const MAX_SLASH_COMMAND_DESCRIPTION_LENGTH = 1_024;
export const MAX_SLASH_COMMAND_KIND_LENGTH = 128;
export const MAX_SLASH_COMMAND_IMAGE_THUMBHASH_LENGTH = 512;
export const MAX_SLASH_COMMAND_ARGUMENTS_LENGTH = 1_000_000;
export const MAX_SLASH_COMMAND_CATALOG_BYTES = 256 * 1_024;

/** Artwork metadata; bytes come from the focused command's `image` endpoint. */
export const slashCommandImageSchema = Type.Object({
    /** Base64 ThumbHash placeholder for the image. */
    thumbhash: Type.String({
        minLength: 1,
        maxLength: MAX_SLASH_COMMAND_IMAGE_THUMBHASH_LENGTH,
    }),
});

/** One public slash command, without its owning module's private handler. */
export const slashCommandSchema = Type.Object({
    description: Type.String({
        minLength: 1,
        maxLength: MAX_SLASH_COMMAND_DESCRIPTION_LENGTH,
    }),
    hasArguments: Type.Boolean(),
    image: Type.Optional(slashCommandImageSchema),
    kind: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_SLASH_COMMAND_KIND_LENGTH })),
    /** The command itself, without a leading slash. */
    name: Type.String({
        minLength: 1,
        maxLength: MAX_SLASH_COMMAND_NAME_LENGTH,
        pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    }),
});

/** The complete ordered catalog returned for one focused agent. */
export const slashCommandCatalogSchema = Type.Array(slashCommandSchema, {
    maxItems: MAX_SLASH_COMMANDS,
});

/** `POST /v0/agents/:agentId/slash-commands/:name` */
export const invokeSlashCommandRequestSchema = Type.Object({
    arguments: Type.Optional(Type.String({ maxLength: MAX_SLASH_COMMAND_ARGUMENTS_LENGTH })),
    mode: messageModeSchema,
    mutationId: Type.Optional(mutationIdSchema),
});

export type SlashCommandImage = Static<typeof slashCommandImageSchema>;
export type SlashCommand = Static<typeof slashCommandSchema>;
export type InvokeSlashCommandRequest = Static<typeof invokeSlashCommandRequestSchema>;

/** A response shape that carries the focused agent's complete current command catalog. */
export interface SlashCommandCatalog {
    slashCommands: SlashCommand[];
}

/** `POST /v0/agents/:agentId/slash-commands/:name` */
export interface InvokeSlashCommandResponse extends SlashCommandCatalog, AgentProfileCatalog {
    agent: Agent;
    /** The exact post-refresh descriptor that the owning module accepted. */
    command: SlashCommand;
    /** Stream from here to observe every effect caused by the command. */
    cursor: EventCursor;
}
