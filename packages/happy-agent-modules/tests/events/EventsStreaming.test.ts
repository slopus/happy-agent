import { sql } from "drizzle-orm";
import { agentDatabaseRows } from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";

import { EventsModule } from "../../sources/events/EventsModule.js";
import type { AgentEvent } from "../../sources/events/types.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

function scopeFor(agentId: string) {
    return { agent: { id: agentId, provider: "codex" } } as never;
}

async function journalRows(database: ReturnType<typeof moduleDatabase>): Promise<number> {
    const rows = await agentDatabaseRows<{ count: number }>(
        database.database,
        sql`SELECT count(*) AS count FROM happy_agent_events`,
    );
    return Number(rows[0]!.count);
}

async function activeRunState(
    database: ReturnType<typeof moduleDatabase>,
    agentId: string,
): Promise<string | undefined> {
    const rows = await agentDatabaseRows<{ state_json: string }>(
        database.database,
        sql`SELECT state_json FROM happy_agent_active_runs WHERE agent_id = ${agentId}`,
    );
    return rows[0]?.state_json;
}

async function startedRun(agentId: string, name: string) {
    const events = new EventsModule();
    const database = moduleDatabase(events.migrations, name);
    await database.ready;
    const hooks = await resolveModuleHooks(database.context, events);
    const scope = scopeFor(agentId);
    await hooks.messageAcceptedTransact?.(database.context, scope, {
        id: `${agentId}-message`,
        kind: "send",
        message: { role: "user", content: [{ type: "text", text: "Stream." }] },
        profile: null,
    });
    await hooks.onEvent?.(database.context, scope, { type: "block_start" });
    return { database, events, hooks, scope };
}

describe("EventsModule streaming", () => {
    it("streams text and reasoning fragments to subscribers without journaling them", async () => {
        const { database, events, hooks, scope } = await startedRun(
            "agent-stream",
            "events-stream-fragments",
        );
        try {
            const seen: AgentEvent[] = [];
            events.subscribe((event) => seen.push(event));
            await hooks.onEvent?.(database.context, scope, { type: "reasoning_start" });
            await hooks.onEvent?.(database.context, scope, {
                type: "reasoning_delta",
                delta: "plan",
            });
            await hooks.onEvent?.(database.context, scope, { type: "reasoning_end" });
            await hooks.onEvent?.(database.context, scope, { type: "text_start" });
            const rows = await journalRows(database);
            const run = await activeRunState(database, "agent-stream");
            const window = events.cursor();

            const fragments = Array.from({ length: 50 }, (_, index) => `w${index} `);
            for (const delta of fragments) {
                await hooks.onEvent?.(database.context, scope, { type: "text_delta", delta });
            }

            // No journal row, no active-run rewrite, and nothing added to the replay window.
            expect(await journalRows(database)).toBe(rows);
            expect(await activeRunState(database, "agent-stream")).toBe(run);
            expect(events.cursor()).toBe(window);
            const streamed = seen.filter(
                (event) => (event.payload as { streamed?: boolean }).streamed === true,
            );
            expect(streamed.map((event) => event.payload)).toEqual([
                expect.objectContaining({
                    rigEvent: expect.objectContaining({ delta: "plan", type: "thinking_delta" }),
                }),
                ...fragments.map((delta) =>
                    expect.objectContaining({
                        rigEvent: expect.objectContaining({
                            contentIndex: 1,
                            delta,
                            type: "text_delta",
                        }),
                        runId: "agent-stream-message",
                    }),
                ),
            ]);

            // The durable end carries everything the fragments said.
            await hooks.onEvent?.(database.context, scope, { type: "text_end" });
            const end = events
                .replay(events.originCursor())
                ?.events.filter((event) => event.type === "provider.event")
                .at(-1);
            expect(end?.payload).toMatchObject({
                event: { type: "text_end" },
                rigEvent: {
                    content: fragments.join(""),
                    partial: {
                        content: [
                            { thinking: "plan", type: "thinking" },
                            { text: fragments.join(""), type: "text" },
                        ],
                    },
                },
                text: fragments.join(""),
            });
            expect(await journalRows(database)).toBe(rows + 1);
        } finally {
            database.close();
        }
    });

    it("chains in-memory streamed versions with durable agent versions", async () => {
        const { database, events, hooks, scope } = await startedRun(
            "agent-versions",
            "events-stream-versions",
        );
        try {
            const seen: AgentEvent[] = [];
            events.subscribe((event) => seen.push(event));
            await hooks.onEvent?.(database.context, scope, { type: "text_start" });
            const start = seen.at(-1)!.id;
            expect(
                (await events.latestAgentEvent(database.context, "agent-versions"))?.cursor,
            ).toBe(start);

            await hooks.onEvent?.(database.context, scope, { type: "text_delta", delta: "a" });
            await hooks.onEvent?.(database.context, scope, { type: "text_delta", delta: "b" });
            const [first, second] = seen.slice(-2).map((event) => event.id);
            expect(first! > start).toBe(true);
            expect(second! > first!).toBe(true);
            expect(await events.previousCursor(database.context, "agent-versions", first)).toBe(
                start,
            );
            expect(await events.previousCursor(database.context, "agent-versions", second)).toBe(
                first,
            );
            const latest = await events.latestAgentEvent(database.context, "agent-versions");
            expect(latest).toEqual({ cursor: second, occurredAt: seen.at(-1)!.occurredAt });

            await hooks.onEvent?.(database.context, scope, { type: "text_end" });
            const end = seen.at(-1)!.id;
            expect(await events.previousCursor(database.context, "agent-versions", end)).toBe(
                second,
            );
            expect(
                (await events.latestAgentEvent(database.context, "agent-versions"))?.cursor,
            ).toBe(end);

            // Streamed versions live only in this process; a restart answers from the journal.
            const restarted = new EventsModule();
            await restarted.beforeStart(database.context);
            expect(
                (await restarted.latestAgentEvent(database.context, "agent-versions"))?.cursor,
            ).toBe(end);
            expect(await restarted.previousCursor(database.context, "agent-versions", end)).toBe(
                start,
            );
        } finally {
            database.close();
        }
    });

    it("announces a tool call only when its generation starts and ends", async () => {
        const { database, events, hooks, scope } = await startedRun(
            "agent-tools",
            "events-stream-tools",
        );
        try {
            const seen: AgentEvent[] = [];
            events.subscribe((event) => seen.push(event));
            const rows = await journalRows(database);
            await hooks.onEvent?.(database.context, scope, {
                type: "toolcall_start",
                callId: "call-quiet",
                name: "exec_command",
            });
            const run = await activeRunState(database, "agent-tools");
            const argumentsJson = JSON.stringify({ cmd: "ls -la", workdir: "/tmp" });
            for (const delta of argumentsJson.match(/.{1,3}/gu) ?? []) {
                await hooks.onEvent?.(database.context, scope, {
                    type: "toolcall_delta",
                    callId: "call-quiet",
                    delta,
                });
            }
            expect(await activeRunState(database, "agent-tools")).toBe(run);
            await hooks.onEvent?.(database.context, scope, {
                type: "toolcall_end",
                callId: "call-quiet",
                arguments: argumentsJson,
            });

            expect(
                seen.map((event) => (event.payload as { event: { type: string } }).event.type),
            ).toEqual(["toolcall_start", "toolcall_end"]);
            expect(seen.at(-1)?.payload).toMatchObject({
                rigEvent: {
                    toolCall: { arguments: { cmd: "ls -la", workdir: "/tmp" }, id: "call-quiet" },
                    type: "toolcall_end",
                },
            });
            expect(await journalRows(database)).toBe(rows + 2);
        } finally {
            database.close();
        }
    });
});
