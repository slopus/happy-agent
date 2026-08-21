import { createHash } from "node:crypto";

import { Value } from "@sinclair/typebox/value";
import {
    withAgentConfig,
    type AgentModule,
    type AgentModuleHooks,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import {
    MAX_SLASH_COMMAND_CATALOG_BYTES,
    MAX_SLASH_COMMANDS,
    invokeSlashCommandRequestSchema,
    slashCommandSchema,
    type SlashCommand,
} from "@slopus/happy-agent-client";
import type { Context } from "@steve.kite/stdlib";

import { EventsModule, eventAgentIdSchema } from "../events/index.js";
import {
    SlashCommandInputError,
    SlashCommandNotFoundError,
    slashCommandDefinitionSchema,
    type SlashCommandContributor,
    type SlashCommandDefinition,
    type SlashCommandImageAsset,
    type SlashCommandInvocation,
    type SlashCommandInvocationResult,
} from "./SlashCommand.js";

interface CachedCommand {
    readonly descriptor: SlashCommand;
    readonly image?: SlashCommandImageAsset;
    readonly owner: SlashCommandContributor;
}

interface CachedCatalog {
    readonly commands: readonly CachedCommand[];
    readonly fingerprint: string;
}

/** Merges module-owned slash commands into one current per-agent command surface. */
export class SlashCommandsModule implements AgentModule {
    readonly name = "slash-commands";
    readonly #cache = new Map<string, CachedCatalog>();
    readonly #contributors: readonly SlashCommandContributor[];
    readonly #events: EventsModule;
    readonly #refreshes = new Map<string, Promise<CachedCatalog>>();
    #agents: AgentSystemRef | undefined;

    constructor(events: EventsModule, ...contributors: SlashCommandContributor[]) {
        this.#events = events;
        this.#contributors = contributors;
    }

    async catalog(ctx: Context, agentId: string): Promise<SlashCommand[]> {
        const cached = this.#cache.get(agentId) ?? (await this.refresh(ctx, agentId));
        return structuredClone(cached.commands.map(({ descriptor }) => descriptor));
    }

    async image(
        _ctx: Context,
        agentId: string,
        name: string,
    ): Promise<SlashCommandImageAsset | undefined> {
        const cached = this.#cache.get(agentId);
        if (cached === undefined) return undefined;
        const image = cached.commands.find((command) => command.descriptor.name === name)?.image;
        return image === undefined ? undefined : { ...image, blob: new Uint8Array(image.blob) };
    }

    async invoke(
        ctx: Context,
        agentId: string,
        name: string,
        input: SlashCommandInvocation,
    ): Promise<SlashCommandInvocationResult> {
        if (!Value.Check(invokeSlashCommandRequestSchema, input)) {
            throw new SlashCommandInputError("The slash command invocation is invalid.");
        }
        const refreshed = await this.refresh(ctx, agentId);
        const command = refreshed.commands.find((candidate) => candidate.descriptor.name === name);
        if (command === undefined) {
            throw new SlashCommandNotFoundError(`Unknown slash command "${name}".`);
        }
        if (!command.descriptor.hasArguments && input.arguments !== undefined) {
            throw new SlashCommandInputError(`The /${name} command does not accept arguments.`);
        }
        await command.owner.invokeSlashCommand(
            await this.#agentContext(ctx, agentId),
            agentId,
            name,
            structuredClone(input),
        );
        return {
            command: structuredClone(command.descriptor),
            slashCommands: structuredClone(refreshed.commands.map(({ descriptor }) => descriptor)),
        };
    }

    async refresh(ctx: Context, agentId: string): Promise<CachedCatalog> {
        if (!Value.Check(eventAgentIdSchema, agentId)) {
            throw new Error("Slash command discovery received an invalid agent ID.");
        }
        const active = this.#refreshes.get(agentId);
        if (active !== undefined) return await active;
        const refreshing = this.#discover(ctx, agentId);
        this.#refreshes.set(agentId, refreshing);
        try {
            return await refreshing;
        } finally {
            if (this.#refreshes.get(agentId) === refreshing) this.#refreshes.delete(agentId);
        }
    }

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return {
            agentCreated: async (ctx, _scope, agent) => {
                await this.refresh(ctx, agent.id);
            },
            agentRestored: async (ctx, _scope, agent) => {
                await this.refresh(ctx, agent.id);
            },
            beforeTurn: async (ctx, scope) => {
                await this.refresh(ctx, scope.agent.id);
                return undefined;
            },
        };
    };

    async #discover(ctx: Context, agentId: string): Promise<CachedCatalog> {
        const agentCtx = await this.#agentContext(ctx, agentId);
        const commands: CachedCommand[] = [];
        const names = new Set<string>();
        for (const owner of this.#contributors) {
            const definitions = await owner.slashCommands(agentCtx, agentId);
            for (const definition of definitions) {
                if (!Value.Check(slashCommandDefinitionSchema, definition)) {
                    throw new Error(
                        `The ${owner.name} module returned an invalid slash command definition.`,
                    );
                }
                if (names.has(definition.name)) {
                    throw new Error(
                        `More than one module returned the /${definition.name} command.`,
                    );
                }
                if (commands.length >= MAX_SLASH_COMMANDS) {
                    throw new Error(
                        `Slash command discovery exceeded ${String(MAX_SLASH_COMMANDS)} commands.`,
                    );
                }
                names.add(definition.name);
                const descriptor: SlashCommand = {
                    description: definition.description,
                    hasArguments: definition.hasArguments,
                    ...(definition.image === undefined
                        ? {}
                        : { image: { thumbhash: definition.image.thumbhash } }),
                    ...(definition.kind === undefined ? {} : { kind: definition.kind }),
                    name: definition.name,
                };
                if (!Value.Check(slashCommandSchema, descriptor)) {
                    throw new Error(
                        `The ${owner.name} module produced an invalid public slash command.`,
                    );
                }
                const image =
                    definition.image === undefined
                        ? undefined
                        : {
                              blob: new Uint8Array(definition.image.blob),
                              etag: contentEtag(definition.image.blob),
                              mediaType: definition.image.mediaType,
                          };
                commands.push({
                    descriptor,
                    ...(image === undefined ? {} : { image }),
                    owner,
                });
            }
        }
        const descriptors = commands.map(({ descriptor }) => descriptor);
        const encoded = JSON.stringify(descriptors);
        if (Buffer.byteLength(encoded, "utf8") > MAX_SLASH_COMMAND_CATALOG_BYTES) {
            throw new Error("The slash command catalog exceeds its encoded size limit.");
        }
        const fingerprint = createHash("sha256")
            .update(encoded)
            .update("\0")
            .update(
                commands
                    .map(({ image }) =>
                        image === undefined ? "" : `${image.mediaType}:${image.etag}`,
                    )
                    .join("\0"),
            )
            .digest("hex");
        const next = { commands, fingerprint };
        const previous = this.#cache.get(agentId);
        if (previous?.fingerprint !== fingerprint) {
            await this.#events.record(ctx, {
                agentId,
                payload: { slashCommands: descriptors },
                type: "slash_commands.updated",
            });
        }
        this.#cache.set(agentId, next);
        return next;
    }

    async #agentContext(ctx: Context, agentId: string): Promise<Context> {
        const agents = this.#agents;
        if (agents === undefined) throw new Error("The slash commands module has not started.");
        const config = await agents.config(ctx, agentId);
        if (config === undefined) throw new SlashCommandNotFoundError("The agent was not found.");
        return withAgentConfig(ctx, config);
    }
}

function contentEtag(bytes: Uint8Array): string {
    return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}
