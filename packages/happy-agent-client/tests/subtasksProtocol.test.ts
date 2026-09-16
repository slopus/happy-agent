import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { agentSchema, type Agent } from "../sources/protocol/agents.js";
import type { HappyAgentEvent } from "../sources/protocol/events.js";
import { workspaceSchema, type Workspace } from "../sources/protocol/workspaces.js";
import { readEventStream } from "../sources/readEventStream.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const agent: Agent = {
    id: "subtask1",
    workspaceId: "workspace1",
    parentAgentId: "parent1",
    userVisible: true,
    managedByAnotherAgent: true,
    canSendMessages: true,
    subtask: true,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    version,
    lastCursor: version,
    orderKey: null,
    pendingQuestionId: null,
    processes: { running: 0 },
    subagents: { running: 0, total: 0 },
    status: "idle",
    title: "Build the app",
    titleStatus: "ready",
    unread: null,
};

const workspace: Workspace = {
    id: "workspace1",
    projectId: "project1",
    parentId: "project1",
    subtaskAgentId: agent.id,
    agents: [{ ...agent, orderKey: "1" }],
    archivedAt: null,
    base: null,
    botId: null,
    compute: { type: "host", path: "/project/workspace" },
    createdAt: 1,
    updatedAt: 1,
    creatorAgentId: "parent1",
    git: null,
    initialization: { status: "ready", attempt: 1, error: null },
    kind: "copy",
    name: "build-app",
    nameSource: "user",
    orderKey: "1",
    status: "active",
    version,
};

describe("subtask protocol", () => {
    it.each([true, false, undefined])("accepts additive subtask flag %s", (subtask) => {
        expect(Value.Check(agentSchema, { ...agent, subtask })).toBe(true);
    });

    it.each([null, "true", 1, {}])("rejects non-boolean subtask flag %j", (subtask) => {
        expect(Value.Check(agentSchema, { ...agent, subtask })).toBe(false);
    });

    it.each([agent.id, null, undefined])(
        "accepts additive workspace association %s",
        (subtaskAgentId) => {
            expect(Value.Check(workspaceSchema, { ...workspace, subtaskAgentId })).toBe(true);
        },
    );

    it.each([true, 1, [], {}])("rejects invalid workspace association %j", (subtaskAgentId) => {
        expect(Value.Check(workspaceSchema, { ...workspace, subtaskAgentId })).toBe(false);
    });

    it("preserves subtask identity in creation and workspace update streams", async () => {
        const events: HappyAgentEvent[] = [
            { cursor: version, occurredAt: 1, type: "agent.created", payload: { agent } },
            {
                cursor: version,
                occurredAt: 1,
                type: "workspace.updated",
                payload: {
                    workspaceId: workspace.id,
                    previousVersion: version,
                    version,
                    changes: { subtaskAgentId: agent.id, agents: workspace.agents },
                },
            },
        ];
        const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
            start(controller) {
                controller.enqueue(
                    new TextEncoder().encode(
                        events
                            .map(
                                (event) =>
                                    `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                            )
                            .join(""),
                    ),
                );
                controller.close();
            },
        });
        const frames = [];
        for await (const frame of readEventStream(stream)) frames.push(frame);
        expect(frames).toEqual(
            events.map((event) => ({ cursor: event.cursor, kind: "event", event })),
        );
    });
});
