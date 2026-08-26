import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    type Bot,
    botListResponseSchema,
    botResponseSchema,
    botSchema,
    createBotRequestSchema,
    renameBotRequestSchema,
    reorderBotRequestSchema,
} from "../sources/protocol/bots.js";
import { desktopBootstrapResponseSchema } from "../sources/protocol/bootstrap.js";
import {
    botCreatedPayloadSchema,
    botUpdatedPayloadSchema,
    type HappyAgentEvent,
} from "../sources/protocol/events.js";
import { workspaceSchema } from "../sources/protocol/workspaces.js";
import { readEventStream } from "../sources/readEventStream.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const nextVersion = "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f";
const updatedAt = 1_755_400_000_000;

const bot: Bot = {
    agent: {
        archivedAt: null,
        canSendMessages: true,
        createdAt: updatedAt - 10_000,
        id: "agent1",
        lastCursor: version,
        managedByAnotherAgent: false,
        orderKey: null,
        parentAgentId: null,
        pendingQuestionId: null,
        processes: { running: 0 },
        status: "idle",
        subagents: { running: 0, total: 0 },
        title: null,
        titleStatus: "idle",
        unread: null,
        updatedAt,
        userVisible: true,
        version,
        workspaceId: "workspace1",
    },
    archivedAt: null,
    avatar: {
        kind: "image",
        source: "user",
        thumbhash: "3OcRJYB4d3h3iIeHeEh3eIhw+j2w",
    },
    compute: { path: "/Users/steve/Happy/Bots/research_assistant", type: "host" },
    createdAt: updatedAt - 10_000,
    id: "bot1",
    name: "Research Assistant",
    orderKey: "00000000000000000001",
    status: "active",
    updatedAt,
    username: "research_assistant",
    version,
    workspaceId: "workspace1",
};

describe("bots protocol", () => {
    it("validates the full bot object and list/single response wrappers", () => {
        expect(Value.Check(botSchema, bot)).toBe(true);
        expect(Value.Check(botResponseSchema, { bot })).toBe(true);
        expect(Value.Check(botListResponseSchema, { bots: [bot] })).toBe(true);

        expect(Value.Check(botSchema, { ...bot, status: "deleted" })).toBe(false);
        expect(Value.Check(botSchema, { ...bot, username: "Research-Assistant" })).toBe(false);
        expect(Value.Check(botSchema, { ...bot, name: "   " })).toBe(false);
    });

    it("validates creation, immutable username, and nullable reorder destinations", () => {
        expect(
            Value.Check(createBotRequestSchema, {
                id: "bot1",
                mutationId: "create-1",
                name: "Research Assistant",
                username: "research_assistant",
            }),
        ).toBe(true);
        expect(Value.Check(createBotRequestSchema, { name: "Research Assistant" })).toBe(true);
        expect(
            Value.Check(createBotRequestSchema, {
                name: "Research Assistant",
                username: "1_research",
            }),
        ).toBe(false);

        expect(Value.Check(renameBotRequestSchema, { name: "Research Buddy" })).toBe(true);
        expect(
            Value.Check(renameBotRequestSchema, {
                name: "Research Buddy",
                username: "research_buddy",
            }),
        ).toBe(false);
        expect(Value.Check(reorderBotRequestSchema, { afterId: null })).toBe(true);
        expect(Value.Check(reorderBotRequestSchema, { afterId: "bot2" })).toBe(true);
    });

    it("models bot workspaces outside project trees while keeping botId additive", () => {
        const workspace = {
            agents: [bot.agent],
            archivedAt: null,
            base: null,
            botId: bot.id,
            compute: bot.compute,
            createdAt: bot.createdAt,
            creatorAgentId: null,
            git: null,
            id: bot.workspaceId,
            initialization: { attempt: 1, error: null, status: "ready" },
            kind: "bot",
            name: bot.username,
            nameSource: "user",
            orderKey: "0",
            parentId: null,
            projectId: null,
            status: "active",
            updatedAt: bot.updatedAt,
            version: bot.version,
        };
        const { botId: _botId, ...legacyWorkspace } = workspace;

        expect(Value.Check(workspaceSchema, workspace)).toBe(true);
        expect(Value.Check(workspaceSchema, legacyWorkspace)).toBe(true);
        expect(
            Value.Check(workspaceSchema, {
                ...workspace,
                botId: undefined,
                id: "project1",
                kind: "root",
                name: "Project",
                projectId: "project1",
            }),
        ).toBe(true);
    });

    it("keeps bots optional and additive in protocol-22 desktop bootstrap", () => {
        expect(desktopBootstrapResponseSchema.required ?? []).not.toContain("bots");
        expect(Value.Check(desktopBootstrapResponseSchema.properties.bots, [bot])).toBe(true);
    });

    it("validates and parses bot.created and version-chained bot.updated events", async () => {
        const created: HappyAgentEvent = {
            cursor: version,
            occurredAt: updatedAt,
            payload: { bot, mutationId: "create-1" },
            type: "bot.created",
        };
        const updated: HappyAgentEvent = {
            cursor: nextVersion,
            occurredAt: updatedAt + 1,
            payload: {
                botId: bot.id,
                changes: { name: "Research Buddy", updatedAt: updatedAt + 1 },
                mutationId: "rename-1",
                previousVersion: version,
                version: nextVersion,
            },
            type: "bot.updated",
        };

        expect(Value.Check(botCreatedPayloadSchema, created.payload)).toBe(true);
        expect(Value.Check(botUpdatedPayloadSchema, updated.payload)).toBe(true);
        expect(
            Value.Check(botUpdatedPayloadSchema, {
                ...updated.payload,
                previousVersion: undefined,
            }),
        ).toBe(false);

        const frames = [];
        for await (const frame of readEventStream(
            streamOf(
                [
                    `id: ${version}\nevent: bot.created\ndata: ${JSON.stringify(created)}\n\n`,
                    `id: ${nextVersion}\nevent: bot.updated\ndata: ${JSON.stringify(updated)}\n\n`,
                ].join(""),
            ),
        )) {
            frames.push(frame);
        }

        expect(frames).toEqual([
            { cursor: version, event: created, kind: "event" },
            { cursor: nextVersion, event: updated, kind: "event" },
        ]);
    });
});

function streamOf(text: string): ReadableStream<Uint8Array<ArrayBuffer>> {
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        },
    });
}
