import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as published from "happy-agent-client-0.0.136";
import { describe, expect, it } from "vitest";

import * as current from "../sources/index.js";

const at = 1_755_400_000_000;
const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const agent = {
    id: "a9b8c7d6e5f4g3h2i1j0k9l8",
    workspaceId: "w5v4u3t2s1r0q9p8o7n6m5l4",
    parentAgentId: null,
    title: "Fix login redirect",
    titleStatus: "ready",
    status: "idle",
    subagents: { total: 0, running: 0 },
    processes: { running: 0 },
    pendingQuestionId: null,
    orderKey: null,
    lastCursor: version,
    version,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    unread: { reason: "story_reply", since: at, from: ["u1x2y3z4a5b6c7d8e9f0g1h2"] },
};
const task = {
    id: "t4k8m2q9w1e5r7y3u6i0o2p4",
    name: "Fix login redirect",
    folderName: "fix_login_redirect",
    ownerUserId: "u1x2y3z4a5b6c7d8e9f0g1h2",
    creatorAgentId: null,
    workspaceId: agent.workspaceId,
    compute: { type: "host", path: "/Users/steve/Happy/Tasks/fix_login_redirect" },
    status: "active",
    agent,
    version,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    icon: { type: "library", slug: "rocket" },
    children: [
        {
            ref: { kind: "artifact", id: "r7k2m9q4w1e5t8y3u6i0o2p5" },
            visibility: "hidden",
            by: { agentId: agent.id, userId: null },
            updatedAt: at,
        },
    ],
};
const membership = {
    taskId: task.id,
    userId: task.ownerUserId,
    orderKey: "5",
    joinedAt: at,
    hidden: true,
};
const [hidden, unread] = [false, { reason: "looped_in", since: at, agentId: agent.id, note: "X" }];
// A bot shares a task's identity and lifecycle fields; task-only extras are tolerated.
const bot = { ...task, username: "social_growth", avatar: null, orderKey: "1", hidden, unread };
const section = {
    id: "s9d8f7g6h5j4k3l2m1n0b9v8",
    name: "Priorities",
    orderKey: "3",
    collapsed: false,
};
const replyTo = { kind: "story", artifactId: "r1t2y3u4i5o6p7a8s9d0f1g2" };
const surfaceMessage = {
    id: "m4k8m2q9w1e5r7y3u6i0o2p4",
    surfaceId: "s4k8m2q9w1e5r7y3u6i0o2p4",
    seq: 1,
    authorUserId: null,
    text: "Ship it",
    status: "active",
    createdAt: at,
    updatedAt: at,
    editedAt: null,
    deletedAt: null,
    version,
    replyTo,
};
const bootstrapPart = {
    tasks: [task],
    taskMemberships: [membership],
    taskSections: [section],
    taskArtifacts: [
        {
            artifactId: "r7k2m9q4w1e5t8y3u6i0o2p5",
            taskId: task.id,
            agentId: agent.id,
            title: "Demo",
            type: "video",
            updatedAt: at,
        },
    ],
};

/** Every response or event payload a protocol-34 daemon may send an older client. */
function responses(c: typeof current | typeof published): [string, TSchema, unknown][] {
    return [
        [
            "health",
            c.healthResponseSchema,
            {
                healthy: true,
                ready: true,
                status: "ready",
                version: { protocol: 34, daemon: "1.2.3" },
                capabilities: {
                    taskSections: true,
                    storyArtifacts: true,
                    chatActions: true,
                    chatOnboarding: true,
                },
            },
        ],
        [
            "task list",
            c.taskListResponseSchema,
            { tasks: [task], memberships: [membership], sections: [section] },
        ],
        ["task response", c.taskResponseSchema, { task, membership }],
        ["agent", c.agentSchema, agent],
        [
            "task.updated",
            c.taskUpdatedPayloadSchema,
            {
                taskId: task.id,
                previousVersion: version,
                version,
                changes: { icon: task.icon, children: task.children },
            },
        ],
        ["task.membership.updated", c.taskMembershipPayloadSchema, { membership }],
        ["bot list", c.botListResponseSchema, { bots: [bot] }],
        [
            "bot.updated for one person",
            c.botUpdatedPayloadSchema,
            { botId: bot.id, previousVersion: version, version, changes: { hidden, unread } },
        ],
        [
            "chat page",
            c.surfaceMessagePageResponseSchema,
            {
                messages: [surfaceMessage],
                nextBeforeSeq: null,
                nextAfterSeq: null,
                cursor: version,
            },
        ],
        ["bootstrap", Type.Partial(c.desktopBootstrapResponseSchema), bootstrapPart],
        [
            "user_settings.updated",
            c.userSettingsUpdatedPayloadSchema,
            {
                setting: { key: "tasks.rich", value: true, updatedAt: at, version },
            },
        ],
    ];
}

describe("rich tasks contract", () => {
    it("opts in to story artifacts only when asked", async () => {
        const urls: string[] = [];
        const fetch = async (input: RequestInfo | URL) => {
            urls.push(String(input instanceof Request ? input.url : input));
            return Response.json({ runs: [], hasMore: false, cursor: version });
        };
        const client = new current.HappyAgentClient({
            endpoint: "http://agent.local",
            token: "t",
            fetch,
        });
        const id = "r1t2y3u4i5o6p7a8s9d0f1g2";
        expect(client.artifactFileUrl(id, 1, "story.json", { type: "story" })).toContain(
            "type=story",
        );
        expect(client.artifactFileUrl(id, 1, "story.json")).not.toContain("type=");
        await client.getMessages(agent.id);
        expect(urls[0]).not.toContain("include=");
    });

    it.each(
        responses(published).map((row, i) => [row[0], row[1], responses(current)[i]![1], row[2]]),
    )(
        "the published 0.0.136 client and this one both parse the %s payload",
        (_name, old, next, payload) => {
            expect(Value.Errors(old as TSchema, payload).First()).toBeUndefined();
            expect(Value.Errors(next as TSchema, payload).First()).toBeUndefined();
        },
    );

    it("keeps story artifacts away from older clients, which cannot parse them", () => {
        const artifactType = Type.Object({ type: published.artifactTypeSchema });
        expect(Value.Check(artifactType, { type: "story" })).toBe(false);
        expect(Value.Check(current.artifactResourceTypeSchema, "story")).toBe(true);
        expect(Value.Check(current.artifactTypeSchema, "story")).toBe(false);
    });

    it("parses the new-only payloads and requests", () => {
        const story = {
            artifactId: replyTo.artifactId,
            artifactVersion: 1,
            audience: "owner",
            caption: null,
            poster: { kind: "agent", agentId: agent.id, taskId: task.id, botId: null },
            replyAgentId: agent.id,
            media: { artifactId: "r7k2m9q4w1e5t8y3u6i0o2p5", version: 3, path: "demo.mp4" },
            round: null,
            repostOf: null,
            postedAt: at,
            expiresAt: at + 86_400_000,
            state: "live",
            endedAt: null,
            takenDownBy: null,
            seenBy: [{ userId: null, seenAt: at }],
            replies: 0,
        };
        expect(
            Value.Errors(current.storyListResponseSchema, {
                stories: [story],
                cursor: version,
            }).First(),
        ).toBeUndefined();
        expect(Value.Check(current.storyChangedPayloadSchema, { story })).toBe(true);
        expect(Value.Check(current.taskSectionsUpdatedPayloadSchema, { sections: [section] })).toBe(
            true,
        );
        expect(Value.Check(current.updateTaskRequestSchema, { icon: null })).toBe(true);
        expect(Value.Check(current.setBotVisibilityRequestSchema, { hidden: true })).toBe(true);
        expect(Value.Check(current.setBotVisibilityRequestSchema, {})).toBe(false);
        expect(Value.Check(current.updateTaskRequestSchema, { mutationId: "m1" })).toBe(false);
        expect(
            Value.Check(current.reorderTaskAfterSectionRequestSchema, {
                afterSectionId: section.id,
            }),
        ).toBe(true);
        expect(
            Value.Check(current.replaceTaskSectionsRequestSchema, {
                sections: [
                    {
                        id: section.id,
                        name: "Priorities",
                        collapsed: false,
                        after: { taskId: task.id },
                    },
                ],
            }),
        ).toBe(true);
        expect(
            Value.Check(current.sendSurfaceMessageRequestSchema, { text: "Ship it", replyTo }),
        ).toBe(true);
        expect(
            Value.Check(current.actionBlockSchema, {
                type: "action",
                messageId: "tz4a98xxat96iws9zmbrgj3a",
                blockIndex: 0,
                controlIndex: 1,
                actionId: "reply",
                params: {},
            }),
        ).toBe(true);
        // Two buttons with the same action and parameters differ only by `controlIndex`.
        const press = { type: "action", messageId: "tz4a98xxat96iws9zmbrgj3a", blockIndex: 0 };
        expect(
            Value.Check(current.actionBlockSchema, { ...press, actionId: "reply", params: {} }),
        ).toBe(false);
        // Exactly one reorder anchor, and a name beside an icon must still be a name.
        const both = { afterId: null, afterSectionId: section.id };
        expect(Value.Check(current.reorderTaskRequestSchema, both)).toBe(false);
        expect(Value.Check(current.reorderTaskAfterSectionRequestSchema, both)).toBe(false);
        expect(Value.Check(current.updateTaskRequestSchema, { name: 42, icon: null })).toBe(false);
        // An older daemon's request schemas refuse what only a protocol-34 daemon accepts.
        expect(
            Value.Check(published.reorderTaskRequestSchema, { afterSectionId: section.id }),
        ).toBe(false);
        expect(
            Value.Check(published.sendSurfaceMessageRequestSchema, { text: "Ship it", replyTo }),
        ).toBe(false);
    });
});
