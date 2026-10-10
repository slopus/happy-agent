import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { desktopBootstrapResponseSchema } from "../sources/protocol/bootstrap.js";
import {
    taskCreatedPayloadSchema,
    taskMembershipPayloadSchema,
    taskUpdatedPayloadSchema,
    type HappyAgentEvent,
} from "../sources/protocol/events.js";
import {
    reorderTaskRequestSchema,
    taskListResponseSchema,
    taskListScopeSchema,
    taskResponseSchema,
    taskSchema,
    type Task,
    type TaskMembership,
} from "../sources/protocol/tasks.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const nextVersion = "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f";
const updatedAt = 1_755_400_000_000;

const task: Task = {
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
        title: "Fix login redirect",
        titleStatus: "ready",
        unread: null,
        updatedAt,
        userVisible: true,
        version,
        workspaceId: "workspace1",
    },
    archivedAt: null,
    compute: { path: "/Users/steve/Happy/Tasks/fix_login_redirect", type: "host" },
    createdAt: updatedAt - 10_000,
    creatorAgentId: "botagent1",
    folderName: "fix_login_redirect",
    id: "task1",
    name: "Fix login redirect",
    ownerUserId: "owner1",
    status: "active",
    updatedAt,
    version,
    workspaceId: "workspace1",
};

const membership: TaskMembership = {
    joinedAt: updatedAt,
    orderKey: "5",
    taskId: task.id,
    userId: "owner1",
};

describe("tasks protocol", () => {
    it("validates tasks without an avatar or catalog order, and per-person memberships", () => {
        expect(Value.Check(taskSchema, task)).toBe(true);
        expect(Value.Check(taskSchema, { ...task, ownerUserId: null, creatorAgentId: null })).toBe(
            true,
        );
        expect(Value.Check(taskSchema, { ...task, folderName: "Not A Folder" })).toBe(false);
        expect(
            Value.Check(taskListResponseSchema, { tasks: [task], memberships: [membership] }),
        ).toBe(true);
        expect(Value.Check(taskResponseSchema, { task, membership })).toBe(true);
        expect(Value.Check(taskResponseSchema, { task, membership: null })).toBe(true);
        // A standalone installation's one person has no user ID.
        expect(
            Value.Check(taskResponseSchema, { task, membership: { ...membership, userId: null } }),
        ).toBe(true);
        expect(Value.Check(reorderTaskRequestSchema, { afterId: null })).toBe(true);
        expect(Value.Check(reorderTaskRequestSchema, { afterId: "task2" })).toBe(true);
        expect(Value.Check(taskListScopeSchema, "joined")).toBe(true);
        expect(Value.Check(taskListScopeSchema, "mine")).toBe(false);
    });

    it("keeps tasks and memberships optional and additive in desktop bootstrap", () => {
        const required = desktopBootstrapResponseSchema.required ?? [];
        expect(required).not.toContain("tasks");
        expect(required).not.toContain("taskMemberships");
        expect(Value.Check(desktopBootstrapResponseSchema.properties.tasks, [task])).toBe(true);
        expect(
            Value.Check(desktopBootstrapResponseSchema.properties.taskMemberships, [membership]),
        ).toBe(true);
    });

    it("validates task and membership events", () => {
        const events: HappyAgentEvent[] = [
            {
                cursor: version,
                occurredAt: updatedAt,
                payload: { task },
                type: "task.created",
            },
            {
                cursor: nextVersion,
                occurredAt: updatedAt + 1,
                payload: {
                    taskId: task.id,
                    changes: { name: "Fix the redirect", updatedAt: updatedAt + 1 },
                    previousVersion: version,
                    version: nextVersion,
                },
                type: "task.updated",
            },
            {
                cursor: nextVersion,
                occurredAt: updatedAt + 2,
                payload: { membership, mutationId: "join-1" },
                type: "task.joined",
            },
        ];
        expect(Value.Check(taskCreatedPayloadSchema, events[0]?.payload)).toBe(true);
        expect(Value.Check(taskUpdatedPayloadSchema, events[1]?.payload)).toBe(true);
        expect(Value.Check(taskMembershipPayloadSchema, events[2]?.payload)).toBe(true);
        expect(Value.Check(taskMembershipPayloadSchema, { mutationId: "leave-1" })).toBe(false);
    });

    it("lists, reads, joins, leaves, and reorders through the task routes", async () => {
        const requests: { method: string; url: string; body: string | null }[] = [];
        const fetch: typeof globalThis.fetch = async (input, init) => {
            requests.push({
                body: typeof init?.body === "string" ? init.body : null,
                method: init?.method ?? "GET",
                url: input.toString(),
            });
            const body =
                input.toString().includes("/v0/tasks?") || input.toString().endsWith("/v0/tasks")
                    ? { tasks: [task], memberships: [membership] }
                    : { task, membership };
            return new Response(JSON.stringify(body), {
                headers: { "content-type": "application/json" },
                status: 200,
            });
        };
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        await expect(client.listTasks()).resolves.toEqual({
            tasks: [task],
            memberships: [membership],
        });
        await client.listTasks({ scope: "joined" });
        await expect(client.getTask("task/1")).resolves.toEqual({ task, membership });
        await client.joinTask("task1", { mutationId: "join-1" });
        await client.leaveTask("task1");
        await client.reorderTask("task1", { afterId: null, mutationId: "reorder-1" });

        expect(requests).toEqual([
            { body: null, method: "GET", url: "http://agent.local/v0/tasks" },
            { body: null, method: "GET", url: "http://agent.local/v0/tasks?scope=joined" },
            { body: null, method: "GET", url: "http://agent.local/v0/tasks/task%2F1" },
            {
                body: JSON.stringify({ mutationId: "join-1" }),
                method: "POST",
                url: "http://agent.local/v0/tasks/task1/join",
            },
            { body: "{}", method: "POST", url: "http://agent.local/v0/tasks/task1/leave" },
            {
                body: JSON.stringify({ afterId: null, mutationId: "reorder-1" }),
                method: "POST",
                url: "http://agent.local/v0/tasks/task1/reorder",
            },
        ]);
    });
});
