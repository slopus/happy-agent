import { readFile } from "node:fs/promises";
import { Agent, agentDatabaseRun } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { contextRequest, contextWindowFixture } from "./contextWindowFixture.js";
import { textTurn, user } from "../support/fixtures.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

describe("retained native Context window", () => {
    it("reads full native records in order, without modifying context, KV or relay bindings", async () => {
        const fixture = await contextWindowFixture();
        try {
            const before = await fixture.persistence.load(fixture.ctx);
            const binding = await fixture.sync.readSession(fixture.ctx, "nativeagent");
            const expected = JSON.parse(
                await readFile(
                    new URL("./fixtures/context-response.json", import.meta.url),
                    "utf8",
                ),
            );
            expect(await fixture.read()).toEqual(expected);
            expect(await fixture.read()).toEqual(expected);
            expect(await fixture.persistence.load(fixture.ctx)).toEqual(before);
            expect(await fixture.persistence.readValues(fixture.ctx, "pending.")).toEqual([]);
            expect(await fixture.sync.readSession(fixture.ctx, "nativeagent")).toEqual(binding);
        } finally {
            await fixture.close();
        }
    });

    it("resolves remote identity only within the original owner, account and cwd", async () => {
        const fixture = await contextWindowFixture();
        try {
            for (const answer of [
                await fixture.read(contextRequest, "owner-b"),
                await fixture.read(contextRequest, "owner-a", "account-b"),
                await fixture.read({ ...contextRequest, directory: "/other/project" }),
                await fixture.read({ ...contextRequest, sessionId: "nativeagent" }),
            ])
                expect(answer).toEqual({ type: "error", reason: "missing" });
            expect(
                await fixture.read({ provider: "rig", directory: contextRequest.directory }),
            ).toEqual({ type: "error", reason: "unsupported" });
            expect(await fixture.read({ ...contextRequest, provider: "codex" })).toEqual({
                type: "error",
                reason: "unsupported",
            });
            expect(await fixture.read({ ...contextRequest, stateHome: "/other/home" })).toEqual({
                type: "error",
                reason: "unsupported",
            });
        } finally {
            await fixture.close();
        }
    });

    it("reports missing, malformed and unsupported records honestly and retries fresh reads", async () => {
        const fixture = await contextWindowFixture();
        try {
            const initial = await fixture.read();
            await agentDatabaseRun(
                fixture.ctx.db,
                sql`ALTER TABLE happy_agent_records RENAME TO fixture_unavailable_records`,
            );
            expect(await fixture.read()).toEqual({ type: "error", reason: "unreadable" });
            await agentDatabaseRun(
                fixture.ctx.db,
                sql`ALTER TABLE fixture_unavailable_records RENAME TO happy_agent_records`,
            );
            expect(await fixture.read()).toEqual(initial);
            await fixture.persistence.clearRecords(fixture.ctx);
            expect(await fixture.read()).toEqual({ type: "error", reason: "missing" });
            await agentDatabaseRun(
                fixture.ctx.db,
                sql`INSERT INTO happy_agent_records(owner_id, position, record_json) VALUES ('nativeagent', 0, 'broken-json')`,
            );
            expect(await fixture.read()).toEqual({ type: "error", reason: "unreadable" });
            await fixture.persistence.clearRecords(fixture.ctx);
            await agentDatabaseRun(
                fixture.ctx.db,
                sql`INSERT INTO happy_agent_records(owner_id, position, record_json) VALUES ('nativeagent', 0, '{"type":"future-kind"}')`,
            );
            expect(await fixture.read()).toEqual({ type: "error", reason: "unsupported" });
            await fixture.persistence.clearRecords(fixture.ctx);
            await fixture.persistence.append(fixture.ctx, fixture.records[0]!);
            expect(await fixture.read()).toMatchObject({
                type: "success",
                entries: [{ kind: "context.compaction" }],
            });
        } finally {
            await fixture.close();
        }
    });

    it("excludes rolled-back writes and preserves a fork's installed inherited snapshot", async () => {
        const fixture = await contextWindowFixture();
        try {
            const before = await fixture.read();
            await expect(
                fixture.ctx.inTx(async (ctx) => {
                    await fixture.persistence.clearRecords(ctx);
                    await fixture.persistence.append(ctx, {
                        type: "system",
                        message: {
                            role: "system",
                            content: [{ type: "text", text: "must roll back" }],
                        },
                    });
                    throw new Error("rollback fixture");
                }),
            ).rejects.toThrow("rollback fixture");
            expect(await fixture.read()).toEqual(before);
            const inherited = {
                type: "compaction" as const,
                contextToolIds: [],
                messages: [user("Inherited fork snapshot")],
            };
            const config = await fixture.system.config(fixture.ctx, "nativeagent");
            if (config === undefined) throw new Error("Missing native config");
            await fixture.system.create(fixture.ctx, config, {
                id: "nativechild",
                parent: "nativeagent",
                initialContext: { messages: inherited.messages },
            });
            await fixture.sync.ensureSession(
                fixture.ctx,
                {
                    agentId: "nativechild",
                    sessionId: "nativechild",
                    credentialFingerprint: "account-a",
                    encryptionKeyBase64: "a2V5",
                    encryptionVariant: "legacy",
                },
                3,
            );
            await fixture.sync.setRemoteSession(fixture.ctx, "nativechild", "remote-child", 4);
            expect(await fixture.system.parentOf(fixture.ctx, "nativechild")).toBe("nativeagent");
            expect(
                await fixture.ctx.inTx(
                    async (ctx) => await fixture.read(contextRequest, "owner-a", "account-a", ctx),
                ),
            ).toEqual(before);
            expect(
                await fixture.read({ ...contextRequest, sessionId: "remote-child" }),
            ).toMatchObject({
                type: "success",
                entries: [{ kind: "context.compaction", content: JSON.stringify(inherited) }],
            });
        } finally {
            await fixture.close();
        }
    });

    it("reads a real Agent compaction boundary and accepted hidden injection from native SQLite", async () => {
        const provider = new ScriptedProvider([
            textTurn("Before compaction"),
            textTurn("After hidden injection"),
        ]);
        const fixture = await contextWindowFixture(provider);
        let agent: Agent | undefined;
        try {
            await fixture.persistence.clearRecords(fixture.ctx);
            const session = provider.session.bind(provider);
            const checkpoint = {
                role: "compaction" as const,
                content: "Actual sanitized compacted summary",
                encryptedContent: "fixture-opaque-checkpoint",
            };
            provider.session = async (id, options) => {
                const value = await session(id, options);
                value.compact = async () => ({
                    status: "completed",
                    preservedMessages: [],
                    usage: { input: 30, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 35 },
                    context: { instructions: "", messages: [checkpoint] },
                });
                return value;
            };
            agent = await fixture.system.resolve(fixture.ctx, "nativeagent");
            await agent.send(fixture.ctx, user("The pre-compaction request"));
            await agent.waitForIdle();
            expect(await fixture.persistence.load(fixture.ctx)).toHaveLength(2);
            await agent.compact(fixture.ctx);
            await agent.waitForIdle();
            expect(await fixture.persistence.load(fixture.ctx)).toEqual([
                { type: "compaction", contextToolIds: [], messages: [checkpoint] },
            ]);
            await agent.send(
                fixture.ctx,
                { role: "system", content: [{ type: "text", text: "Recorded hidden injection" }] },
                { metadata: { hideFromUser: true } },
            );
            await agent.waitForIdle();
            const response = await fixture.read();
            expect(response.type).toBe("success");
            if (response.type !== "success") throw new Error("Expected recoverable context");
            expect(response.entries.map((entry) => entry.kind)).toEqual([
                "context.compaction",
                "context.user",
                "context.block",
            ]);
            expect(response.entries.map((entry) => JSON.parse(entry.content))).toEqual(
                await fixture.persistence.load(fixture.ctx),
            );
            expect(JSON.parse(response.entries[1]!.content)).toMatchObject({
                metadata: { hideFromUser: true },
                message: { role: "system" },
            });
            expect(JSON.stringify(response)).not.toContain("The pre-compaction request");
            await agent.compact(fixture.ctx);
            await agent.waitForIdle();
            expect(await fixture.persistence.load(fixture.ctx)).toEqual([
                { type: "compaction", contextToolIds: [], messages: [checkpoint] },
            ]);
            expect(await fixture.read()).toMatchObject({
                type: "success",
                entries: [
                    {
                        kind: "context.compaction",
                        content: JSON.stringify({
                            type: "compaction",
                            contextToolIds: [],
                            messages: [checkpoint],
                        }),
                    },
                ],
            });
        } finally {
            await agent?.close();
            await fixture.close();
        }
    });
});
