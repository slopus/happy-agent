import { agentDatabaseRun } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
    BotSettingsError,
    DEFAULT_BOT_SETTINGS,
    type BotSettings,
    type BotSettingsEvent,
} from "../../sources/botSettings/index.js";
import { governedTree } from "./support.js";

const LOCKED: BotSettings = {
    allowedSecretIds: ["deploy-token"],
    crossWorkspace: false,
    compute: { type: "docker", image: "node:22" },
};

describe("BotSettingsModule", () => {
    it("runs an unconfigured bot with the defaults and governs nothing", async () => {
        const tree = await governedTree("bot-settings-defaults");
        try {
            await expect(tree.botSettings.read(tree.ctx, "botagent")).resolves.toEqual(
                DEFAULT_BOT_SETTINGS,
            );
            await expect(
                tree.botSettings.governing(tree.ctx, "subtaskagent"),
            ).resolves.toBeUndefined();
            await expect(
                tree.botSettings.allowedSecretIds(tree.ctx, "subtaskagent"),
            ).resolves.toBeNull();
            await expect(
                tree.botSettings.allowsCrossWorkspace(tree.ctx, "subtaskagent"),
            ).resolves.toBe(true);
            await expect(tree.botSettings.compute(tree.ctx, "subtaskagent")).resolves.toEqual({
                type: "host",
            });
            await expect(
                tree.botSettings.mayReach(tree.ctx, "subtaskagent", "otherchild"),
            ).resolves.toBe(true);
            await expect(
                tree.hooks.instructions?.(tree.ctx, tree.scope("subtaskagent")),
            ).resolves.toBe("");
        } finally {
            tree.close();
        }
    });

    it("governs the bot's agent and every descendant with the bot's settings", async () => {
        const tree = await governedTree("bot-settings-descendants");
        try {
            await tree.botSettings.write(tree.ctx, "botagent", LOCKED);
            for (const agentId of ["botagent", "subtaskagent", "collaboratoragent"]) {
                await expect(tree.botSettings.governing(tree.ctx, agentId)).resolves.toEqual({
                    botAgentId: "botagent",
                    settings: LOCKED,
                });
                await expect(tree.botSettings.allowedSecretIds(tree.ctx, agentId)).resolves.toEqual(
                    ["deploy-token"],
                );
                await expect(
                    tree.botSettings.allowsCrossWorkspace(tree.ctx, agentId),
                ).resolves.toBe(false);
                await expect(tree.botSettings.compute(tree.ctx, agentId)).resolves.toEqual({
                    type: "docker",
                    image: "node:22",
                });
            }
            // Another bot's tree is not touched by this bot's settings.
            await expect(
                tree.botSettings.governing(tree.ctx, "otherchild"),
            ).resolves.toBeUndefined();
            // A new descendant is governed the moment it exists; nothing has to be copied to it.
            tree.parents.set("latechild", "collaboratoragent");
            await expect(
                tree.botSettings.allowsCrossWorkspace(tree.ctx, "latechild"),
            ).resolves.toBe(false);
        } finally {
            tree.close();
        }
    });

    it("keeps a restricted bot's agents within the bot's own tree", async () => {
        const tree = await governedTree("bot-settings-reach");
        try {
            await tree.botSettings.write(tree.ctx, "botagent", LOCKED);
            const reach = (from: string, to: string) =>
                tree.botSettings.mayReach(tree.ctx, from, to);
            await expect(reach("collaboratoragent", "botagent")).resolves.toBe(true);
            await expect(reach("botagent", "collaboratoragent")).resolves.toBe(true);
            await expect(reach("subtaskagent", "subtaskagent")).resolves.toBe(true);
            await expect(reach("subtaskagent", "otherbotagent")).resolves.toBe(false);
            await expect(reach("subtaskagent", "otherchild")).resolves.toBe(false);
            await expect(reach("subtaskagent", "missingagent")).resolves.toBe(false);
            // The restriction is on the bot's own reach; an ungoverned agent is not narrowed.
            await expect(reach("otherchild", "subtaskagent")).resolves.toBe(true);

            await tree.botSettings.write(tree.ctx, "botagent", { ...LOCKED, crossWorkspace: true });
            await expect(reach("subtaskagent", "otherchild")).resolves.toBe(true);
        } finally {
            tree.close();
        }
    });

    it("keeps a root created from inside a bot's tree governed by that bot", async () => {
        const tree = await governedTree("bot-settings-adopted-roots");
        try {
            await tree.botSettings.write(tree.ctx, "botagent", LOCKED);
            tree.parents.set("taskagent", null);
            tree.parents.set("tasksubtask", "taskagent");
            tree.parents.set("nestedtask", null);
            await tree.ctx.inTx(async (txCtx) => {
                await tree.botSettings.adoptRoot(txCtx, "taskagent", "subtaskagent");
                // A task made by the task stays with the same bot, not with the task.
                await tree.botSettings.adoptRoot(txCtx, "nestedtask", "tasksubtask");
            });
            for (const agentId of ["taskagent", "tasksubtask", "nestedtask"]) {
                await expect(tree.botSettings.governing(tree.ctx, agentId)).resolves.toMatchObject({
                    botAgentId: "botagent",
                });
            }
            await expect(
                tree.botSettings.mayReach(tree.ctx, "tasksubtask", "botagent"),
            ).resolves.toBe(true);
            await expect(
                tree.botSettings.mayReach(tree.ctx, "nestedtask", "otherbotagent"),
            ).resolves.toBe(false);
            // A root keeps the tree it was created in; a later adoption does not move it.
            await tree.botSettings.adoptRoot(tree.ctx, "taskagent", "otherchild");
            await expect(tree.botSettings.governing(tree.ctx, "taskagent")).resolves.toMatchObject({
                botAgentId: "botagent",
            });
            // An agent never adopts itself.
            await tree.botSettings.adoptRoot(tree.ctx, "otherbotagent", "otherbotagent");
            await expect(
                tree.botSettings.governing(tree.ctx, "otherbotagent"),
            ).resolves.toBeUndefined();
        } finally {
            tree.close();
        }
    });

    it("records a change once, in order, and announces it after commit", async () => {
        const tree = await governedTree("bot-settings-write");
        try {
            const inside: BotSettingsEvent[] = [];
            const after: BotSettingsEvent[] = [];
            tree.botSettings.onEventTransactional((_ctx, event) => {
                inside.push(event);
            });
            tree.botSettings.onEvent((_ctx, event) => {
                after.push(event);
            });
            await expect(
                tree.ctx.inTx(async (txCtx) => {
                    await tree.botSettings.write(txCtx, "botagent", LOCKED);
                    expect(inside).toHaveLength(1);
                    expect(after).toHaveLength(0);
                    throw new Error("roll back");
                }),
            ).rejects.toThrow("roll back");
            expect(after).toHaveLength(0);
            await expect(tree.botSettings.read(tree.ctx, "botagent")).resolves.toEqual(
                DEFAULT_BOT_SETTINGS,
            );

            const first = await tree.botSettings.write(tree.ctx, "botagent", {
                ...LOCKED,
                allowedSecretIds: ["zeta", "alpha"],
            });
            expect(first).toMatchObject({
                changed: true,
                previous: DEFAULT_BOT_SETTINGS,
                settings: { allowedSecretIds: ["alpha", "zeta"] },
            });
            expect(after).toEqual([
                expect.objectContaining({
                    type: "bot_settings_updated",
                    botAgentId: "botagent",
                    previous: DEFAULT_BOT_SETTINGS,
                    settings: { ...LOCKED, allowedSecretIds: ["alpha", "zeta"] },
                }),
            ]);
            // The same settings in another order are the same settings: nothing changes.
            const again = await tree.botSettings.write(tree.ctx, "botagent", {
                ...LOCKED,
                allowedSecretIds: ["alpha", "zeta"],
            });
            expect(again.changed).toBe(false);
            expect(after).toHaveLength(1);
        } finally {
            tree.close();
        }
    });

    it("refuses settings on anything but a bot's own root agent, and invalid settings", async () => {
        const tree = await governedTree("bot-settings-refusals");
        try {
            await expect(tree.botSettings.write(tree.ctx, "subtaskagent", LOCKED)).rejects.toThrow(
                BotSettingsError,
            );
            await expect(
                tree.botSettings.write(tree.ctx, "botagent", {
                    ...LOCKED,
                    allowedSecretIds: ["Not A Secret"],
                }),
            ).rejects.toThrow("The bot settings are invalid.");
            await expect(
                tree.botSettings.write(tree.ctx, "botagent", {
                    ...LOCKED,
                    compute: { type: "docker", image: "node 22" },
                }),
            ).rejects.toThrow("The bot settings are invalid.");
            expect(() => tree.botSettings.merge(DEFAULT_BOT_SETTINGS, {} as never)).toThrow(
                "The bot settings change is invalid.",
            );
        } finally {
            tree.close();
        }
    });

    it("fails closed on stored settings or ancestry it cannot read", async () => {
        const tree = await governedTree("bot-settings-corrupt");
        try {
            await tree.botSettings.write(tree.ctx, "botagent", LOCKED);
            await agentDatabaseRun(
                tree.database.database,
                sql`UPDATE happy_agent_module_bot_settings SET settings_json = '{"crossWorkspace":true}'`,
            );
            // A restriction that cannot be read is not read as no restriction.
            await expect(
                tree.botSettings.allowsCrossWorkspace(tree.ctx, "subtaskagent"),
            ).rejects.toThrow("invalid settings");
            tree.parents.set("loopa", "loopb");
            tree.parents.set("loopb", "loopa");
            await expect(tree.botSettings.governing(tree.ctx, "loopa")).rejects.toThrow(
                "ancestry is corrupt",
            );
        } finally {
            tree.close();
        }
    });

    it("merges a patch, and names exactly what a change widens", async () => {
        const tree = await governedTree("bot-settings-widenings");
        try {
            const { botSettings } = tree;
            expect(botSettings.merge(LOCKED, { crossWorkspace: true })).toEqual({
                ...LOCKED,
                crossWorkspace: true,
            });
            expect(botSettings.merge(DEFAULT_BOT_SETTINGS, { allowedSecretIds: [] })).toEqual({
                ...DEFAULT_BOT_SETTINGS,
                allowedSecretIds: [],
            });
            // Only narrowing: fewer secrets, less reach, and into a container.
            expect(
                botSettings.widenings(DEFAULT_BOT_SETTINGS, {
                    allowedSecretIds: [],
                    crossWorkspace: false,
                    compute: { type: "docker", image: "node:22" },
                }),
            ).toEqual([]);
            expect(botSettings.widenings(LOCKED, { ...LOCKED, allowedSecretIds: [] })).toEqual([]);
            expect(
                botSettings.widenings(LOCKED, {
                    allowedSecretIds: ["deploy-token", "github", "npm"],
                    crossWorkspace: true,
                    compute: { type: "docker", image: "ubuntu:24.04" },
                }),
            ).toEqual([
                'allowing the secrets "github", "npm"',
                "restoring reach to other projects, workspaces, tasks, bots, and agents outside the bot",
                'changing the bot\'s Docker image from "node:22" to "ubuntu:24.04"',
            ]);
            expect(botSettings.widenings(LOCKED, DEFAULT_BOT_SETTINGS)).toEqual([
                "removing the secret allowlist, so every secret attached to the bot or where it works becomes usable",
                "restoring reach to other projects, workspaces, tasks, bots, and agents outside the bot",
                'moving the bot\'s commands out of the Docker image "node:22" onto the host machine',
            ]);
            expect(botSettings.describe(LOCKED)).toBe(
                [
                    'Secrets: only "deploy-token".',
                    "Reach: only the bot's own agents.",
                    'Compute: a Docker container of "node:22" with only each agent\'s folder mounted.',
                    "Stories: off.",
                ].join("\n"),
            );
        } finally {
            tree.close();
        }
    });

    it("tells every governed agent what its bot restricts", async () => {
        const tree = await governedTree("bot-settings-instructions");
        try {
            await tree.botSettings.write(tree.ctx, "botagent", {
                ...DEFAULT_BOT_SETTINGS,
                allowedSecretIds: [],
            });
            const restricted = await tree.hooks.instructions?.(
                tree.ctx,
                tree.scope("collaboratoragent"),
            );
            expect(restricted).toContain("Happy Agent enforces these limits");
            expect(restricted).toContain("No secrets are available");
            expect(restricted).not.toContain("only this bot's own agents");
            await expect(
                tree.hooks.instructions?.(tree.ctx, tree.scope("otherchild")),
            ).resolves.toBe("");
            // Stored settings that restrict nothing say nothing.
            await tree.botSettings.write(tree.ctx, "botagent", DEFAULT_BOT_SETTINGS);
            await expect(
                tree.hooks.instructions?.(tree.ctx, tree.scope("collaboratoragent")),
            ).resolves.toBe("");
        } finally {
            tree.close();
        }
    });
});
