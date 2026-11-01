import type {
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AgentSystemRef,
} from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import {
    BotSettingsError,
    botSettingsEventSchema,
    botSettingsPatchSchema,
    botSettingsSchema,
    DEFAULT_BOT_SETTINGS,
    type BotComputeSetting,
    type BotSettings,
    type BotSettingsEvent,
    type BotSettingsEventListener,
    type BotSettingsGovernance,
    type BotSettingsPatch,
    type BotSettingsUnsubscribe,
} from "./BotSettings.js";
import { botSettingsMigrations } from "./BotSettingsMigrations.js";
import {
    insertGoverningRoot,
    readGoverningRoot,
    readStoredBotSettings,
    writeStoredBotSettings,
} from "./BotSettingsStore.js";
import { formatBotSettings } from "./impl/formatBotSettings.js";
import { formatBotSettingsInstructions } from "./impl/formatBotSettingsInstructions.js";
import { describeBotSettingsWidenings } from "./impl/describeBotSettingsWidenings.js";

/** Deeper than any real agent tree; a longer chain is corrupt ancestry, not a deep tree. */
const MAX_ANCESTRY = 64;
/** A task made by a bot's agent is one hop; anything past a few hops is a corrupt link chain. */
const MAX_ROOT_LINKS = 8;

/**
 * The owner's restrictions on each bot, and which bot governs any given agent.
 *
 * This module is a leaf on purpose. Secrets, compute, collaboration, scheduling, history,
 * projects, workspaces, tasks, subtasks, and bots each enforce one part of a bot's settings, and
 * most of them are built before the bots catalog exists, so none of them can ask the bots module.
 * They ask this one instead, which needs nothing but the agent collection: a bot's settings are
 * keyed by the bot's own agent, and an agent is governed by the bot whose agent is the root of its
 * tree. Subtasks, collaborators, workflow agents, and exported-bot conversations are ordinary
 * descendants, so they are covered by ancestry alone. A root created from inside a tree, such as a
 * task a bot made, is linked to that tree when it is created and stays governed by it.
 *
 * A bot without stored settings runs with the defaults, which restrict nothing.
 */
export class BotSettingsModule implements AgentModule {
    readonly name = "botSettings";
    readonly migrations = botSettingsMigrations;

    readonly #transactionalListeners = new Set<BotSettingsEventListener>();
    readonly #listeners = new Set<BotSettingsEventListener>();
    #agents: AgentSystemRef | undefined;

    readonly #hooks: AgentModuleHooks = {
        /** Tell a governed agent what is closed to it, so it does not keep trying. */
        instructions: async (ctx: Context, scope: AgentModuleScope): Promise<string> => {
            const governance = await this.governing(ctx, scope.agent.id);
            return governance === undefined
                ? ""
                : formatBotSettingsInstructions(governance.settings);
        },
    };

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return this.#hooks;
    };

    onEventTransactional(listener: BotSettingsEventListener): BotSettingsUnsubscribe {
        this.#transactionalListeners.add(listener);
        return () => this.#transactionalListeners.delete(listener);
    }

    onEvent(listener: BotSettingsEventListener): BotSettingsUnsubscribe {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /** One bot's settings, read from its own agent; the defaults when none were stored. */
    async read(ctx: Context, botAgentId: string): Promise<BotSettings> {
        return structuredClone(
            (await readStoredBotSettings(ctx, botAgentId))?.settings ?? DEFAULT_BOT_SETTINGS,
        );
    }

    /**
     * Replace one bot's settings. The bots catalog decides who may; this records the decision.
     * Writing what is already stored changes nothing and announces nothing.
     */
    async write(
        ctx: Context,
        botAgentId: string,
        settings: BotSettings,
    ): Promise<{
        readonly previous: BotSettings;
        readonly settings: BotSettings;
        readonly changed: boolean;
    }> {
        if (!Value.Check(botSettingsSchema, settings)) {
            throw new BotSettingsError("The bot settings are invalid.");
        }
        const next = normalize(settings);
        return await ctx.inTx(async (txCtx) => {
            if ((await this.#requireAgents().parentOf(txCtx, botAgentId)) !== null) {
                throw new BotSettingsError("Only a bot's own agent carries bot settings.");
            }
            const stored = await readStoredBotSettings(txCtx, botAgentId);
            const previous = stored?.settings ?? DEFAULT_BOT_SETTINGS;
            if (this.same(previous, next)) {
                return {
                    previous: structuredClone(previous),
                    settings: structuredClone(previous),
                    changed: false,
                };
            }
            const at = Date.now();
            await writeStoredBotSettings(txCtx, botAgentId, next, (stored?.version ?? 0) + 1, at);
            await this.#publish(txCtx, {
                type: "bot_settings_updated",
                eventId: globalThis.crypto.randomUUID(),
                at,
                botAgentId,
                previous: structuredClone(previous),
                settings: structuredClone(next),
            });
            return {
                previous: structuredClone(previous),
                settings: structuredClone(next),
                changed: true,
            };
        });
    }

    /** The settings a patch produces; omitted fields keep their current values. */
    merge(current: BotSettings, patch: BotSettingsPatch): BotSettings {
        if (
            !Value.Check(botSettingsSchema, current) ||
            !Value.Check(botSettingsPatchSchema, patch)
        ) {
            throw new BotSettingsError("The bot settings change is invalid.");
        }
        return normalize({
            allowedSecretIds:
                patch.allowedSecretIds === undefined
                    ? current.allowedSecretIds
                    : patch.allowedSecretIds,
            crossWorkspace: patch.crossWorkspace ?? current.crossWorkspace,
            compute: patch.compute ?? current.compute,
            stories: patch.stories ?? current.stories ?? false,
        });
    }

    /** Canonical equality: allowlists compare as sets, whatever order they were written in. */
    same(left: BotSettings, right: BotSettings): boolean {
        return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
    }

    /**
     * Every way `next` gives governed agents more than `previous`, in words a reviewer reads. An
     * empty list means the change only narrows.
     */
    widenings(previous: BotSettings, next: BotSettings): readonly string[] {
        return describeBotSettingsWidenings(normalize(previous), normalize(next));
    }

    /** One bot's settings in plain English. */
    describe(settings: BotSettings): string {
        return formatBotSettings(normalize(settings));
    }

    /**
     * The settings in force for an agent, or nothing when no bot with stored settings governs it.
     * Every agent in one bot's tree resolves to the same `botAgentId`.
     */
    async governing(ctx: Context, agentId: string): Promise<BotSettingsGovernance | undefined> {
        const root = await this.#treeRoot(ctx, agentId);
        const stored = await readStoredBotSettings(ctx, root);
        return stored === undefined ? undefined : { botAgentId: root, settings: stored.settings };
    }

    /**
     * Whether the agent's bot leaves reach beyond its own agents to the installation setting. A
     * bot setting only ever narrows; callers combine this with `features.cross_workspace`.
     */
    async allowsCrossWorkspace(ctx: Context, agentId: string): Promise<boolean> {
        return (await this.governing(ctx, agentId))?.settings.crossWorkspace ?? true;
    }

    /**
     * Whether a governed agent may reach the target: always inside its own bot's tree, and
     * elsewhere only when its bot leaves reach to the installation setting.
     */
    async mayReach(ctx: Context, actingAgentId: string, targetAgentId: string): Promise<boolean> {
        if (actingAgentId === targetAgentId) return true;
        const governance = await this.governing(ctx, actingAgentId);
        if (governance === undefined || governance.settings.crossWorkspace) return true;
        return (await this.#treeRoot(ctx, targetAgentId)) === governance.botAgentId;
    }

    /** The secrets the agent's bot allows, or `null` when it restricts none. */
    async allowedSecretIds(ctx: Context, agentId: string): Promise<readonly string[] | null> {
        return (await this.governing(ctx, agentId))?.settings.allowedSecretIds ?? null;
    }

    /** Where the agent's bot runs its agents; the host when nothing governs it. */
    async compute(ctx: Context, agentId: string): Promise<BotComputeSetting> {
        return structuredClone(
            (await this.governing(ctx, agentId))?.settings.compute ?? DEFAULT_BOT_SETTINGS.compute,
        );
    }

    /**
     * The agent at the root of this agent's tree, whether or not any settings are stored for it.
     * For every agent a bot governs, this is the bot's own agent.
     */
    async root(ctx: Context, agentId: string): Promise<string> {
        return await this.#treeRoot(ctx, agentId);
    }

    /**
     * Keep a new root agent inside the tree it was created from. Call it in the transaction that
     * creates the root, so the root is never briefly ungoverned.
     */
    async adoptRoot(ctx: Context, rootAgentId: string, creatorAgentId: string): Promise<void> {
        if (rootAgentId === creatorAgentId) return;
        await insertGoverningRoot(ctx, rootAgentId, await this.#treeRoot(ctx, creatorAgentId));
    }

    /** The agent at the root of this agent's tree, following links from roots made inside one. */
    async #treeRoot(ctx: Context, agentId: string): Promise<string> {
        const agents = this.#requireAgents();
        let current = agentId;
        const seen = new Set<string>();
        for (let links = 0; links <= MAX_ROOT_LINKS; links += 1) {
            for (let depth = 0; ; depth += 1) {
                if (depth > MAX_ANCESTRY || seen.has(current)) {
                    throw new Error("The agent's ancestry is corrupt.");
                }
                seen.add(current);
                const parent = await agents.parentOf(ctx, current);
                if (parent === null) break;
                current = parent;
            }
            const governing = await readGoverningRoot(ctx, current);
            if (governing === undefined) return current;
            current = governing;
        }
        throw new Error("The agent's governing tree is corrupt.");
    }

    async #publish(ctx: Context, event: BotSettingsEvent): Promise<void> {
        if (!Value.Check(botSettingsEventSchema, event)) {
            throw new Error("The bot settings event is invalid.");
        }
        for (const listener of [...this.#transactionalListeners]) await listener(ctx, event);
        const frozen = Object.freeze(structuredClone(event));
        afterCommit(ctx, async (eventCtx) => {
            for (const listener of [...this.#listeners]) {
                try {
                    await listener(eventCtx, frozen);
                } catch (error: unknown) {
                    eventCtx.log.error(
                        "A bot settings subscriber failed.",
                        { eventId: frozen.eventId },
                        error,
                    );
                }
            }
        });
    }

    #requireAgents(): AgentSystemRef {
        if (this.#agents === undefined) throw new Error("The bot settings module has not started.");
        return this.#agents;
    }
}

/** One canonical shape: fixed key order and a sorted allowlist. */
function normalize(settings: BotSettings): BotSettings {
    return {
        ...(settings.stories ? { stories: true } : {}),
        allowedSecretIds:
            settings.allowedSecretIds === null
                ? null
                : [...new Set(settings.allowedSecretIds)].sort(),
        crossWorkspace: settings.crossWorkspace,
        compute:
            settings.compute.type === "host"
                ? { type: "host" }
                : { type: "docker", image: settings.compute.image },
    };
}
