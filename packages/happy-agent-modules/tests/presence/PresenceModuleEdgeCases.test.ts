import { sql } from "drizzle-orm";
import { agentDatabaseRun } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AWAY_PRESENCE, ONLINE_PRESENCE } from "../../sources/presence/PresenceCatalog.js";
import { PresenceModule } from "../../sources/presence/PresenceModule.js";
import { MAX_PRESENCE_DEFINITIONS } from "../../sources/presence/PresenceConfiguration.js";
import { presenceStateSchema } from "../../sources/presence/PresenceState.js";
import { presenceEventSchema } from "../../sources/presence/PresenceEvent.js";
import { getPresenceTool } from "../../sources/presence/tools/get_presence.js";
import { listPresenceTool } from "../../sources/presence/tools/list_presence.js";
import { setPresenceTool } from "../../sources/presence/tools/set_presence.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import { testConfig } from "../support/computeModule.js";
import { presenceConfig } from "./presenceTestSupport.js";

const focus = {
    id: "focus",
    status: "custom" as const,
    title: "Focus",
    emoji: "🎧",
    prompt: "Continue independently unless an answer is essential.",
    answerWaitMs: 15 * 60 * 1000,
};

/** The same state as `focus`, written the way the person writes it in their own settings. */
const FOCUS_TOML = `[presence.states.focus]
title = "Focus"
emoji = "🎧"
prompt = "Continue independently unless an answer is essential."
answer_wait = "15m"
`;

function schedule(overrides: Record<string, unknown> = {}) {
    return {
        days: [1],
        startTime: "09:00",
        endTime: "17:00",
        timeZone: "UTC",
        presence: { status: "away" as const },
        ...overrides,
    };
}

function llmText(blocks: readonly { readonly type: string }[]): string {
    const block = blocks[0];
    return block !== undefined && "text" in block && typeof block.text === "string"
        ? block.text
        : "";
}

describe("PresenceModule edge cases", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("offers the same tools to every agent and never asks for a permission review", async () => {
        const database = moduleDatabase([], "presence-tools-default");
        await database.ready;
        try {
            const module = new PresenceModule(testConfig);
            const hooks = await resolveModuleHooks(database.context, module);
            const tools = (await hooks.tools?.(database.context, {} as never)) ?? [];
            expect(tools.map((tool) => tool.name)).toEqual([
                "get_presence",
                "list_presences",
                "set_presence",
            ]);
            expect(
                tools.every((tool) => tool.shouldReviewInAutoMode({}, database.context) === false),
            ).toBe(true);
            expect(tools.find((tool) => tool.name === "set_presence")).toMatchObject({
                durable: true,
                transactional: true,
            });
        } finally {
            database.close();
        }
    });

    it("writes the configured starting state once, falls back to online, and keeps it after reload", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(100);
        const first = new PresenceModule(
            await presenceConfig(`[presence]
current = "away"
until = 200
`),
        );
        const database = moduleDatabase(first.migrations, "presence-initial-state");
        await database.ready;
        try {
            await first.beforeStart?.(database.context);
            expect(await first.read(database.context)).toMatchObject({
                presenceId: "away",
                expiresAt: 200,
                fallbackPresenceId: "online",
            });
            vi.setSystemTime(200);
            expect(await first.read(database.context)).toMatchObject({
                presenceId: "online",
                status: "online",
            });

            vi.setSystemTime(100);
            const second = new PresenceModule(
                await presenceConfig(`[presence]
current = "offline"
`),
            );
            await second.beforeStart?.(database.context);
            expect(await second.read(database.context)).toMatchObject({
                presenceId: "away",
                status: "away",
            });
        } finally {
            database.close();
        }
    });

    it("rejects unknown selections, invalid expiry, and mismatched fallback inputs without writing", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const module = new PresenceModule(await presenceConfig(FOCUS_TOML));
        const database = moduleDatabase(module.migrations, "presence-invalid-mutations");
        await database.ready;
        try {
            await expect(
                module.setPresence(database.context, { presenceId: "missing" }),
            ).rejects.toThrow('There is no presence called "missing"');
            await expect(module.read(database.context)).resolves.toBeUndefined();
            await expect(
                module.setPresence(database.context, {
                    presenceId: "focus",
                    effectiveFrom: 0,
                    expiresAt: 1_000,
                }),
            ).rejects.toThrow("future");
            await expect(
                module.setTemporary(database.context, {
                    presenceId: "focus",
                    expiresAt: 1_010,
                    effectiveFrom: 1_020,
                }),
            ).rejects.toThrow("expiry must be after");
            await expect(
                module.setPresence(database.context, {
                    presenceId: "focus",
                    fallbackPresenceId: "online",
                    fallback: { presenceId: "missing" },
                }),
            ).rejects.toThrow("disagree");
            await expect(
                module.setPresence(database.context, {
                    status: "custom",
                    presenceId: "focus",
                    fallbackPresenceId: "missing",
                }),
            ).rejects.toThrow('There is no presence called "missing"');
        } finally {
            database.close();
        }
    });

    it("keeps future effective states hidden until their start and returns the fallback after expiry", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const module = new PresenceModule(await presenceConfig(FOCUS_TOML));
        const database = moduleDatabase(module.migrations, "presence-effective-boundaries");
        await database.ready;
        try {
            await module.setPresence(database.context, {
                presenceId: "focus",
                message: "starting later",
                effectiveFrom: 2_000,
                expiresAt: 3_000,
                fallbackPresenceId: "online",
            });
            await expect(module.read(database.context)).resolves.toBeUndefined();
            vi.setSystemTime(2_000);
            await expect(module.read(database.context)).resolves.toMatchObject({
                presenceId: "focus",
                message: "starting later",
                effectiveFrom: 2_000,
                expiresAt: 3_000,
                changesAt: 3_000,
                fallback: { presenceId: "online" },
            });
            vi.setSystemTime(3_000);
            await expect(module.read(database.context)).resolves.toMatchObject({
                presenceId: "online",
                effectiveFrom: 3_000,
            });
        } finally {
            database.close();
        }
    });

    it("treats repeated identical mutations and clears as no-ops without publishing events", async () => {
        const eventTypes: string[] = [];
        const module = new PresenceModule(testConfig);
        module.onEvent((_ctx, event) => {
            eventTypes.push(event.type);
        });
        const database = moduleDatabase(module.migrations, "presence-no-op-events");
        await database.ready;
        try {
            await module.setPresence(database.context, { status: "away" });
            await module.setPresence(database.context, { status: "away" });
            await module.clear(database.context);
            await module.clear(database.context);
            expect(eventTypes).toEqual(["presence_changed", "presence_cleared"]);
        } finally {
            database.close();
        }
    });

    it("persists custom definitions, denies clearing built-ins or configured entries, and reloads them", async () => {
        const module = new PresenceModule(await presenceConfig(FOCUS_TOML));
        const database = moduleDatabase(module.migrations, "presence-definition-lifecycle");
        await database.ready;
        try {
            await expect(
                module.setPresenceDefinition(database.context, { ...focus, id: "online" }),
            ).rejects.toThrow("cannot be replaced");
            await expect(
                module.clearPresenceDefinition(database.context, "online"),
            ).rejects.toThrow("cannot be cleared");
            await expect(module.clearPresenceDefinition(database.context, "focus")).rejects.toThrow(
                "cannot be cleared",
            );

            await module.setPresenceDefinition(database.context, {
                ...focus,
                id: "meeting",
                title: "Meeting",
                emoji: "📅",
            });
            expect(await module.listPresences(database.context)).toContainEqual(
                expect.objectContaining({ id: "meeting", title: "Meeting" }),
            );
            await expect(module.clearPresenceDefinition(database.context, "meeting")).resolves.toBe(
                true,
            );
            await expect(module.clearPresenceDefinition(database.context, "meeting")).resolves.toBe(
                false,
            );

            await module.setPresenceDefinition(database.context, {
                ...focus,
                id: "meeting",
            });
            const restarted = new PresenceModule(testConfig);
            expect(await restarted.listPresences(database.context)).toContainEqual(
                expect.objectContaining({ id: "meeting" }),
            );
        } finally {
            database.close();
        }
    });

    it("rejects clearing the active custom definition but keeps a detached caller result", async () => {
        const module = new PresenceModule(testConfig);
        const database = moduleDatabase(module.migrations, "presence-definition-active");
        await database.ready;
        try {
            const definition = await module.setPresenceDefinition(database.context, focus);
            definition.title = "caller mutation";
            expect(await module.listPresences(database.context)).toContainEqual(focus);
            await module.setPresence(database.context, { presenceId: "focus" });
            await expect(module.clearPresenceDefinition(database.context, "focus")).rejects.toThrow(
                "active presence",
            );
        } finally {
            database.close();
        }
    });

    it("normalizes schedule days, deduplicates identical schedules, and validates references", async () => {
        const events: string[] = [];
        vi.useFakeTimers();
        vi.setSystemTime(Date.parse("2024-01-01T10:00:00Z"));
        const module = new PresenceModule(testConfig);
        module.onEvent((_ctx, event) => {
            events.push(event.type);
        });
        const database = moduleDatabase(module.migrations, "presence-schedule-module");
        await database.ready;
        try {
            const first = await module.setSchedule(database.context, {
                ...schedule({ days: [3, 1] }),
            });
            expect(first.days).toEqual([1, 3]);
            await expect(
                module.setSchedule(database.context, { ...schedule({ days: [1, 3] }) }),
            ).resolves.toEqual(first);
            await expect(
                module.setSchedule(database.context, {
                    ...schedule({ days: [2], presence: { presenceId: "missing" } }),
                }),
            ).rejects.toThrow("There is no presence called");
            expect(events).toEqual(["presence_schedule_set"]);
            await expect(module.clearSchedule(database.context, first.id)).resolves.toBe(true);
            await expect(module.clearSchedule(database.context, first.id)).resolves.toBe(false);
            expect(events).toEqual(["presence_schedule_set", "presence_schedule_cleared"]);
        } finally {
            database.close();
        }
    });

    it("rejects invalid time zones before persisting a schedule", async () => {
        const module = new PresenceModule(testConfig);
        const database = moduleDatabase(module.migrations, "presence-invalid-time-zone");
        await database.ready;
        try {
            await expect(
                module.setSchedule(database.context, {
                    ...schedule(),
                    timeZone: "Not/A/Timezone",
                }),
            ).rejects.toThrow();
            await expect(module.listSchedules(database.context)).resolves.toEqual([]);
        } finally {
            database.close();
        }
    });

    it("rejects an invalid time zone even when a configured state would mask schedule evaluation", async () => {
        const module = new PresenceModule(testConfig);
        const database = moduleDatabase(module.migrations, "presence-invalid-time-zone-masked");
        await database.ready;
        try {
            await module.setPresence(database.context, { status: "online" });
            await expect(
                module.setSchedule(database.context, {
                    ...schedule(),
                    timeZone: "Not/A/Timezone",
                }),
            ).rejects.toThrow();
            await expect(module.listSchedules(database.context)).resolves.toEqual([]);
        } finally {
            database.close();
        }
    });

    it("gives configured state precedence over schedules, then exposes the schedule after clear", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(Date.parse("2024-01-01T10:00:00Z"));
        const module = new PresenceModule(testConfig);
        const database = moduleDatabase(module.migrations, "presence-schedule-precedence");
        await database.ready;
        try {
            await module.setSchedule(database.context, schedule({ presence: { status: "away" } }));
            await module.setPresence(database.context, { status: "offline" });
            await expect(module.read(database.context)).resolves.toMatchObject({
                status: "offline",
            });
            await module.clear(database.context);
            await expect(module.read(database.context)).resolves.toMatchObject({
                status: "away",
            });
        } finally {
            database.close();
        }
    });

    it("delivers one deeply frozen event instance to transactional and post-commit watchers", async () => {
        let transactionalEvent: object | undefined;
        let postCommitEvent: object | undefined;
        vi.useFakeTimers();
        vi.setSystemTime(100);
        const module = new PresenceModule(testConfig);
        module.onEventTransactional((_ctx, event) => {
            transactionalEvent = event;
            expect(Object.isFrozen(event)).toBe(true);
            if (event.type === "presence_changed") {
                expect(Object.isFrozen(event.previous)).toBe(true);
                expect(Object.isFrozen(event.current)).toBe(true);
            }
        });
        module.onEvent((_ctx, event) => {
            postCommitEvent = event;
            expect(Object.isFrozen(event)).toBe(true);
            if (event.type === "presence_changed") {
                expect(Object.isFrozen(event.current)).toBe(true);
            }
        });
        const database = moduleDatabase(module.migrations, "presence-event-freeze");
        await database.ready;
        try {
            await module.setPresence(database.context, { status: "away" });
            expect(postCommitEvent).toBe(transactionalEvent);
            expect(transactionalEvent).toMatchObject({
                type: "presence_changed",
                at: 100,
                current: { presenceId: "away" },
                previous: null,
            });
        } finally {
            database.close();
        }
    });

    it("emits validated event variants for definitions, schedules, and state transitions", async () => {
        const events: unknown[] = [];
        const module = new PresenceModule(testConfig);
        module.onEvent((_ctx, event) => {
            events.push(event);
        });
        const database = moduleDatabase(module.migrations, "presence-event-variants");
        await database.ready;
        try {
            await module.setPresenceDefinition(database.context, {
                ...focus,
                id: "meeting",
            });
            await module.clearPresenceDefinition(database.context, "meeting");
            const configured = await module.setSchedule(database.context, schedule());
            await module.clearSchedule(database.context, configured.id);
            await module.setPresence(database.context, { status: "away" });
            await module.clear(database.context);
            expect(events.map((event) => (event as { type: string }).type)).toEqual([
                "presence_definition_set",
                "presence_definition_cleared",
                "presence_schedule_set",
                "presence_schedule_cleared",
                "presence_changed",
                "presence_cleared",
            ]);
            expect(events.every((event) => Value.Check(presenceEventSchema, event))).toBe(true);
        } finally {
            database.close();
        }
    });

    it("counts the same watcher once however many times it is added", async () => {
        const seen: string[] = [];
        const watcher = (_ctx: unknown, event: { readonly type: string }): void => {
            seen.push(event.type);
        };
        const module = new PresenceModule(testConfig);
        const stopFirst = module.onEvent(watcher);
        const stopSecond = module.onEvent(watcher);
        const database = moduleDatabase(module.migrations, "presence-duplicate-watcher");
        await database.ready;
        try {
            await module.setPresence(database.context, { status: "away" });
            expect(seen).toEqual(["presence_changed"]);
            stopFirst();
            await module.setPresence(database.context, { status: "online" });
            expect(seen).toEqual(["presence_changed"]);
            stopSecond();
        } finally {
            database.close();
        }
    });

    it("publishes no post-commit event or durable state after an outer rollback", async () => {
        const transactional: string[] = [];
        const committed: string[] = [];
        const module = new PresenceModule(testConfig);
        module.onEventTransactional((_ctx, event) => {
            transactional.push(event.type);
        });
        module.onEvent((_ctx, event) => {
            committed.push(event.type);
        });
        const database = moduleDatabase(module.migrations, "presence-outer-rollback");
        await database.ready;
        try {
            await expect(
                database.context.inTx(async (txCtx) => {
                    await module.setPresence(txCtx, { status: "away" });
                    throw new Error("outer rollback");
                }),
            ).rejects.toThrow("outer rollback");
            expect(transactional).toEqual(["presence_changed"]);
            expect(committed).toEqual([]);
            await expect(module.read(database.context)).resolves.toBeUndefined();
        } finally {
            database.close();
        }
    });

    it("rolls back a mutation when a transactional watcher fails", async () => {
        const committed: string[] = [];
        const module = new PresenceModule(testConfig);
        module.onEventTransactional(() => {
            throw new Error("reject presence");
        });
        module.onEvent((_ctx, event) => {
            committed.push(event.type);
        });
        const database = moduleDatabase(module.migrations, "presence-transactional-failure");
        await database.ready;
        try {
            await expect(module.setPresence(database.context, { status: "away" })).rejects.toThrow(
                "reject presence",
            );
            expect(committed).toEqual([]);
            await expect(module.read(database.context)).resolves.toBeUndefined();
        } finally {
            database.close();
        }
    });

    it("contains a post-commit watcher failure instead of undoing a durable commit", async () => {
        const module = new PresenceModule(testConfig);
        const later: string[] = [];
        module.onEvent(() => {
            throw { message: "hostile", toString: () => "hostile" };
        });
        module.onEvent((_ctx, event) => {
            later.push(event.type);
        });
        const database = moduleDatabase(module.migrations, "presence-postcommit-failure");
        await database.ready;
        try {
            await expect(
                module.setPresence(database.context, { status: "away" }),
            ).resolves.toMatchObject({ status: "away" });
            // The failure is reported, never rethrown: the change is already durable and the
            // watchers behind the failing one still hear about it.
            expect(later).toEqual(["presence_changed"]);
            await expect(module.read(database.context)).resolves.toMatchObject({
                status: "away",
            });
        } finally {
            database.close();
        }
    });

    it("subscribes with an initial snapshot, re-arms on changes, and removes failing subscribers", async () => {
        const module = new PresenceModule(testConfig);
        const database = moduleDatabase(module.migrations, "presence-user-input-subscription");
        await database.ready;
        try {
            const snapshots: unknown[] = [];
            const unsubscribe = await module.subscribeUserInput(database.context, (_ctx, state) => {
                snapshots.push(state);
            });
            expect(snapshots).toEqual([undefined]);
            await module.setPresence(database.context, { status: "away" });
            await vi.waitFor(() =>
                expect(snapshots).toEqual([
                    undefined,
                    {
                        answerWaitMs: 0,
                        title: "Away",
                        emoji: "🌙",
                        prompt: AWAY_PRESENCE.prompt,
                    },
                ]),
            );
            unsubscribe();
            await module.setPresence(database.context, { status: "online" });
            expect(snapshots).toHaveLength(2);

            const failing = vi.fn(() => {
                throw new Error("subscriber failed");
            });
            await expect(module.subscribeUserInput(database.context, failing)).rejects.toThrow(
                "subscriber failed",
            );
            await module.setPresence(database.context, { status: "dnd" });
            expect(failing).toHaveBeenCalledOnce();
        } finally {
            database.close();
        }
    });

    it("refuses a user-input subscriber that is not a function", async () => {
        const module = new PresenceModule(testConfig);
        const database = moduleDatabase(module.migrations, "presence-user-input-shape");
        await database.ready;
        try {
            for (const candidate of [undefined, null, 42, "callback", {}]) {
                await expect(
                    module.subscribeUserInput(database.context, candidate as never),
                ).rejects.toThrow("Presence user-input callback is invalid.");
            }
        } finally {
            database.close();
        }
    });

    it("keeps public operations and model tools on one state implementation", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const module = new PresenceModule(await presenceConfig(FOCUS_TOML));
        const database = moduleDatabase(module.migrations, "presence-tool-parity");
        await database.ready;
        try {
            const get = getPresenceTool(module);
            const list = listPresenceTool(module);
            const set = setPresenceTool(module);
            expect(await get.execute(database.context, {} as never, {} as never)).toEqual({
                presence: null,
            });
            const first = await set.execute(
                database.context,
                {
                    input: {
                        presenceId: "focus",
                        message: "deep work",
                        until: 2_000,
                        fallbackPresenceId: "online",
                    },
                },
                { id: "call-1" } as never,
            );
            expect(Value.Check(presenceStateSchema, first.presence)).toBe(true);
            expect(await module.read(database.context)).toEqual(first.presence);
            expect(
                llmText(
                    get.toLLM({
                        presence: first.presence,
                    }),
                ),
            ).toContain("wait 15 minutes");
            expect(llmText(set.toLLM(first))).toContain("Presence set to Focus 🎧");
            const listed = await list.execute(database.context, {} as never, {} as never);
            expect(listed.presences).toContainEqual(focus);
            expect(llmText(list.toLLM(listed))).toContain("focus: Focus 🎧");

            vi.setSystemTime(2_000);
            const expired = await get.execute(database.context, {} as never, {} as never);
            expect(expired.presence).toMatchObject({ status: "online" });
            expect(llmText(get.toLLM(expired))).toContain("wait indefinitely");
        } finally {
            database.close();
        }
    });

    it("keeps large configured catalogs within the tool's explicit output bound", async () => {
        const states = Array.from(
            { length: 55 },
            (_, index) => `[presence.states.focus-${index}]
title = "Focus"
emoji = "🎧"
prompt = "${"p".repeat(2_000)}"
answer_wait = "15m"
`,
        ).join("\n");
        const module = new PresenceModule(await presenceConfig(states));
        const database = moduleDatabase(module.migrations, "presence-catalog-output-bound");
        await database.ready;
        try {
            const tool = listPresenceTool(module);
            const result = await tool.execute(database.context, {} as never, {} as never);
            const output = llmText(tool.toLLM(result));
            expect(output.length).toBeLessThanOrEqual(100_000);
            expect(output).toContain("detailed prompts were omitted");
            expect(output).toContain("focus-0");
        } finally {
            database.close();
        }
    });

    it("does not allow a custom definition referenced by a future fallback to disappear", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(100);
        const module = new PresenceModule(testConfig);
        const database = moduleDatabase(module.migrations, "presence-fallback-definition");
        await database.ready;
        try {
            await module.setPresenceDefinition(database.context, focus);
            await module.setPresence(database.context, {
                status: "away",
                expiresAt: 200,
                fallbackPresenceId: "focus",
            });
            await expect(
                module.clearPresenceDefinition(database.context, "focus"),
            ).rejects.toThrow();
        } finally {
            database.close();
        }
    });

    it("does not allow a custom definition referenced by a schedule to disappear", async () => {
        const module = new PresenceModule(testConfig);
        const database = moduleDatabase(module.migrations, "presence-schedule-definition");
        await database.ready;
        try {
            await module.setPresenceDefinition(database.context, focus);
            await module.setSchedule(database.context, {
                ...schedule(),
                presence: { presenceId: "focus" },
            });
            await expect(
                module.clearPresenceDefinition(database.context, "focus"),
            ).rejects.toThrow();
        } finally {
            database.close();
        }
    });

    it("lets settings refine a built-in state without inventing a new one", async () => {
        const module = new PresenceModule(
            await presenceConfig(`[presence.states.away]
title = "Stepped out"
emoji = "🚶"
`),
        );
        const database = moduleDatabase(module.migrations, "presence-builtin-refinement");
        await database.ready;
        try {
            const catalog = await module.listPresences(database.context);
            expect(catalog).toContainEqual({
                id: "away",
                status: "away",
                title: "Stepped out",
                emoji: "🚶",
                prompt: AWAY_PRESENCE.prompt,
                answerWaitMs: AWAY_PRESENCE.answerWaitMs,
            });
            expect(catalog).toContainEqual({ ...ONLINE_PRESENCE });
        } finally {
            database.close();
        }
    });

    it("refuses more configured states than the catalog can hold", async () => {
        const states = Array.from(
            { length: MAX_PRESENCE_DEFINITIONS - 3 },
            (_, index) => `[presence.states.focus-${index}]\ntitle = "Focus"\n`,
        ).join("\n");
        await expect(
            presenceConfig(states).then((config) => new PresenceModule(config)),
        ).rejects.toThrow(`more than ${String(MAX_PRESENCE_DEFINITIONS)} states`);
    });

    it("stops accepting new definitions once the catalog is full", async () => {
        const states = Array.from(
            { length: MAX_PRESENCE_DEFINITIONS - 4 },
            (_, index) => `[presence.states.focus-${index}]\ntitle = "Focus"\n`,
        ).join("\n");
        const module = new PresenceModule(await presenceConfig(states));
        const database = moduleDatabase(module.migrations, "presence-bounds");
        await database.ready;
        try {
            expect(await module.listPresences(database.context)).toHaveLength(
                MAX_PRESENCE_DEFINITIONS,
            );
            await expect(
                module.setPresenceDefinition(database.context, { ...focus, id: "other" }),
            ).rejects.toThrow("catalog limit");
        } finally {
            database.close();
        }
    });

    it("rejects malformed persisted schedules and state through the module boundary", async () => {
        const module = new PresenceModule(testConfig);
        const database = moduleDatabase(module.migrations, "presence-module-malformed");
        await database.ready;
        try {
            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO happy_agent_presence_schedules (id, schedule_json)
                    VALUES (${"malformed"}, ${JSON.stringify({
                        id: "malformed",
                        days: [2, 1],
                        startTime: "09:00",
                        endTime: "17:00",
                        timeZone: "UTC",
                        presence: { status: "away" },
                    })})`,
            );
            await expect(module.listSchedules(database.context)).rejects.toThrow("canonical");
            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO happy_agent_presence (singleton_id, state_json)
                    VALUES (1, ${JSON.stringify({
                        presenceId: "unknown",
                    })})`,
            );
            await expect(module.read(database.context)).rejects.toThrow("not configured");
        } finally {
            database.close();
        }
    });
});
