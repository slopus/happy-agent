import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_PRESENCE_SCHEDULES, PresenceModule } from "../../sources/presence/PresenceModule.js";
import {
    presenceMigrations,
    PRESENCE_CATALOG_MIGRATION_KEY,
    PRESENCE_MIGRATION_KEY,
    PRESENCE_RECEIPTS_REMOVED_MIGRATION_KEY,
} from "../../sources/presence/PresenceDatabase.js";
import { AWAY_PRESENCE, ONLINE_PRESENCE } from "../../sources/presence/PresenceCatalog.js";
import { presenceStateSchema } from "../../sources/presence/PresenceState.js";
import { setPresenceTool } from "../../sources/presence/tools/set_presence.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import { testConfig } from "../support/computeModule.js";
import { presenceConfig } from "./presenceTestSupport.js";
import { Value } from "@sinclair/typebox/value";

describe("PresenceModule", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("owns stable migrations and persists state through Agent Base's database context", async () => {
        const database = moduleDatabase(presenceMigrations, "presence-test");
        await database.ready;
        try {
            expect(presenceMigrations.map(([key]) => key)).toEqual([
                PRESENCE_MIGRATION_KEY,
                PRESENCE_RECEIPTS_REMOVED_MIGRATION_KEY,
                PRESENCE_CATALOG_MIGRATION_KEY,
            ]);

            const module = new PresenceModule(testConfig);
            await module.setPresence(database.context, {
                status: "away",
                message: "back soon",
            });

            expect(await module.read(database.context)).toEqual({
                presenceId: "away",
                status: "away",
                title: "Away",
                emoji: "🌙",
                prompt: AWAY_PRESENCE.prompt,
                answerWaitMs: 0,
                message: "back soon",
            });

            const restarted = new PresenceModule(testConfig);
            expect(await restarted.read(database.context)).toEqual({
                presenceId: "away",
                status: "away",
                title: "Away",
                emoji: "🌙",
                prompt: AWAY_PRESENCE.prompt,
                answerWaitMs: 0,
                message: "back soon",
            });
        } finally {
            database.close();
        }
    });

    it("uses stdlib afterCommit for committed events and stops when a watcher leaves", async () => {
        const database = moduleDatabase(presenceMigrations, "presence-events-test");
        await database.ready;
        try {
            const events: string[] = [];
            const module = new PresenceModule(testConfig);
            const stopTransactional = module.onEventTransactional((_ctx, event) => {
                events.push(`transactional:${event.type}`);
            });
            const stopCommitted = module.onEvent((_ctx, event) => {
                events.push(`committed:${event.type}`);
            });

            await module.setPresence(database.context, { status: "online" });
            await module.setPresence(database.context, { status: "online" });
            expect(events).toEqual([
                "transactional:presence_changed",
                "committed:presence_changed",
            ]);

            await module.clear(database.context);
            await module.clear(database.context);
            expect(events).toEqual([
                "transactional:presence_changed",
                "committed:presence_changed",
                "transactional:presence_cleared",
                "committed:presence_cleared",
            ]);

            stopTransactional();
            stopCommitted();
            await module.setPresence(database.context, { status: "away" });
            expect(events).toHaveLength(4);
        } finally {
            database.close();
        }
    });

    it("refuses a watcher that is not a function", async () => {
        const module = new PresenceModule(testConfig);
        for (const candidate of [undefined, null, 42, "listener", {}]) {
            expect(() => module.onEvent(candidate as never)).toThrow(
                "Presence event listener must be a function.",
            );
            expect(() => module.onEventTransactional(candidate as never)).toThrow(
                "Presence event listener must be a function.",
            );
        }
    });

    it("lists the states the person configured, persists definitions, and shows every field", async () => {
        const database = moduleDatabase(presenceMigrations, "presence-catalog-test");
        await database.ready;
        try {
            const focus = {
                id: "focus",
                status: "custom" as const,
                title: "Focus time",
                emoji: "🎧",
                prompt: "Continue independently unless an answer is essential.",
                answerWaitMs: 900_000,
            };
            const module = new PresenceModule(
                await presenceConfig(`[presence.states.focus]
title = "Focus time"
emoji = "🎧"
prompt = "Continue independently unless an answer is essential."
answer_wait = "15m"
`),
            );

            expect(await module.listPresences(database.context)).toEqual([
                ...[
                    {
                        ...ONLINE_PRESENCE,
                    },
                    {
                        ...AWAY_PRESENCE,
                    },
                    {
                        id: "offline",
                        status: "offline",
                        title: "Offline",
                        emoji: "⚫",
                        prompt: "The user is offline and cannot be reached. Continue on your own and record anything the user should look at later.",
                        answerWaitMs: 0,
                    },
                    {
                        id: "dnd",
                        status: "dnd",
                        title: "Do not disturb",
                        emoji: "🔕",
                        prompt: "The user has asked not to be disturbed. Continue on your own and record anything the user should look at later.",
                        answerWaitMs: 0,
                    },
                ],
                focus,
            ]);

            await module.setPresence(database.context, { presenceId: "focus" });
            expect(await module.userInputState(database.context)).toEqual({
                answerWaitMs: 900_000,
                title: "Focus time",
                emoji: "🎧",
                prompt: "Continue independently unless an answer is essential.",
            });
            const hooks = await resolveModuleHooks(database.context, module);
            await expect(hooks.instructions!(database.context, {} as never)).resolves.toContain(
                "Continue independently unless an answer is essential.",
            );

            const persisted = {
                id: "meeting",
                status: "custom" as const,
                title: "In a meeting",
                emoji: "📅",
                prompt: "Do not wait for an answer.",
                answerWaitMs: 0,
            };
            await module.setPresenceDefinition(database.context, persisted);
            const restarted = new PresenceModule(testConfig);
            expect(await restarted.listPresences(database.context)).toContainEqual(persisted);
        } finally {
            database.close();
        }
    });

    it("starts in the state the settings name and leaves an existing state alone", async () => {
        const database = moduleDatabase(presenceMigrations, "presence-initial-state-test");
        await database.ready;
        try {
            const config = await presenceConfig(`[presence]
current = "dnd"
`);
            const module = new PresenceModule(config);
            await resolveModuleHooks(database.context, module);
            expect(await module.read(database.context)).toMatchObject({
                presenceId: "dnd",
                status: "dnd",
            });

            await module.setPresence(database.context, { status: "away" });
            const restarted = new PresenceModule(config);
            await resolveModuleHooks(database.context, restarted);
            expect(await restarted.read(database.context)).toMatchObject({ presenceId: "away" });
        } finally {
            database.close();
        }
    });

    it("refuses settings that name a state nobody defined", async () => {
        await expect(
            presenceConfig(`[presence]
current = "nowhere"
`).then((config) => new PresenceModule(config)),
        ).rejects.toThrow('Configured current presence "nowhere" is not defined.');
    });

    it("hands user input the state now and again after every committed change", async () => {
        const database = moduleDatabase(presenceMigrations, "presence-user-input-test");
        await database.ready;
        try {
            const module = new PresenceModule(testConfig);
            await module.setPresence(database.context, { status: "away" });
            expect(await module.userInputState(database.context)).toEqual({
                answerWaitMs: 0,
                title: "Away",
                emoji: "🌙",
                prompt: AWAY_PRESENCE.prompt,
            });

            const changes: unknown[] = [];
            const unsubscribe = await module.subscribeUserInput(database.context, (_ctx, state) => {
                changes.push(state);
            });
            expect(changes).toHaveLength(1);

            await module.setPresence(database.context, { status: "online" });
            await vi.waitFor(() => expect(changes).toHaveLength(2));
            expect(changes[1]).toEqual({
                answerWaitMs: null,
                title: "Online",
                emoji: "🟢",
                prompt: ONLINE_PRESENCE.prompt,
            });

            unsubscribe();
            await module.setPresence(database.context, { status: "dnd" });
            expect(changes).toHaveLength(2);
        } finally {
            database.close();
        }
    });

    it("keeps a saved change when a watcher fails only after the commit", async () => {
        const database = moduleDatabase(presenceMigrations, "presence-post-commit-failure-test");
        await database.ready;
        try {
            const module = new PresenceModule(testConfig);
            const seen: string[] = [];
            module.onEvent(() => {
                throw new Error("watcher exploded");
            });
            module.onEvent((_ctx, event) => {
                seen.push(event.type);
            });

            await module.setPresence(database.context, { status: "away" });
            expect(await module.read(database.context)).toMatchObject({ presenceId: "away" });
            expect(seen).toEqual(["presence_changed"]);
        } finally {
            database.close();
        }
    });

    it("lets the model set an expiry and fallback through the transactional mutation tool", async () => {
        const database = moduleDatabase(presenceMigrations, "presence-tool-commit-test");
        await database.ready;
        try {
            vi.useFakeTimers();
            vi.setSystemTime(1_000);
            const module = new PresenceModule(testConfig);
            const tool = setPresenceTool(module);
            const call = {
                id: "call-presence-1",
            } as never;

            const result = await tool.execute(
                database.context,
                {
                    input: {
                        presenceId: "away",
                        until: 2_000,
                        fallbackPresenceId: "online",
                        message: "back soon",
                    },
                },
                call,
            );

            expect(tool.durable).toBe(true);
            expect(tool.transactional).toBe(true);
            expect(result.presence).toMatchObject({
                presenceId: "away",
                status: "away",
                message: "back soon",
                expiresAt: 2_000,
                fallbackPresenceId: "online",
                answerWaitMs: 0,
            });
            expect(Value.Check(presenceStateSchema, result.presence)).toBe(true);

            vi.setSystemTime(2_000);
            expect(await module.read(database.context)).toMatchObject({
                presenceId: "online",
                status: "online",
                answerWaitMs: null,
            });
        } finally {
            database.close();
        }
    });

    it("offers the same three tools to every agent and bounds its recurring windows", async () => {
        const database = moduleDatabase(presenceMigrations, "presence-tools-test");
        await database.ready;
        try {
            const module = new PresenceModule(testConfig);
            const hooks = await resolveModuleHooks(database.context, module);
            const tools = await hooks.tools!(database.context, {
                agent: { id: "agent-1" },
            } as never);

            expect(tools.map((tool) => tool.name)).toEqual([
                "get_presence",
                "list_presences",
                "set_presence",
            ]);
            expect(MAX_PRESENCE_SCHEDULES).toBe(64);
        } finally {
            database.close();
        }
    });
});
