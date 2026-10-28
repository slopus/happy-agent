import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    HappyAgentClient,
    formatHappyReferenceTag,
    isKnownHappyReferenceKind,
    parseHappyReferenceTag,
    profileSchema,
    profileUpdateRequestSchema,
    usersResponseSchema,
} from "../sources/index.js";
import { taskMembershipPayloadSchema, type HappyAgentEvent } from "../sources/protocol/events.js";
import { taskMembershipSchema, type TaskMembership } from "../sources/protocol/tasks.js";

const USER = "rg799k2m9q4w1e5t8y3u6i0o";
const membership: TaskMembership = {
    joinedAt: 1,
    orderKey: "5",
    taskId: "task1",
    userId: USER,
};
const unread = {
    reason: "looped_in",
    since: 2,
    agentId: "focusagent1",
    note: "Refunds go through Stripe.",
};

describe("teammates protocol", () => {
    it("marks a membership unread, cleared as null, and accepts older daemons and new reasons", () => {
        expect(Value.Check(taskMembershipSchema, membership)).toBe(true);
        expect(Value.Check(taskMembershipSchema, { ...membership, unread })).toBe(true);
        expect(Value.Check(taskMembershipSchema, { ...membership, unread: null })).toBe(true);
        expect(
            Value.Check(taskMembershipSchema, {
                ...membership,
                unread: { reason: "future_reason", since: 3 },
            }),
        ).toBe(true);
        expect(
            Value.Check(taskMembershipSchema, { ...membership, unread: { ...unread, note: "" } }),
        ).toBe(false);
        expect(
            Value.Check(taskMembershipSchema, { ...membership, unread: { reason: "looped_in" } }),
        ).toBe(false);
    });

    it("carries a changed membership in task.membership.updated", () => {
        const event: HappyAgentEvent = {
            cursor: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
            occurredAt: 3,
            payload: { membership: { ...membership, unread: null }, mutationId: "read-1" },
            type: "task.membership.updated",
        };
        expect(Value.Check(taskMembershipPayloadSchema, event.payload)).toBe(true);
    });

    it("describes a member's role and what they follow, optional and nullable", () => {
        const user = {
            id: USER,
            name: "Steve",
            photo: null,
            version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
            updatedAt: 1,
        };
        expect(Value.Check(usersResponseSchema, { users: [user] })).toBe(true);
        expect(
            Value.Check(usersResponseSchema, {
                users: [{ ...user, role: "Billing engineer", follows: "Stripe webhooks" }],
            }),
        ).toBe(true);
        expect(
            Value.Check(usersResponseSchema, { users: [{ ...user, role: null, follows: null }] }),
        ).toBe(true);
        expect(
            Value.Check(usersResponseSchema, { users: [{ ...user, role: "x".repeat(65) }] }),
        ).toBe(false);
        const profile = { ...user, email: null, userId: USER };
        expect(Value.Check(profileSchema, { ...profile, role: "Founder", follows: null })).toBe(
            true,
        );
        expect(Value.Check(profileUpdateRequestSchema, { role: "Founder", follows: null })).toBe(
            true,
        );
        expect(Value.Check(profileUpdateRequestSchema, { follows: "" })).toBe(false);
    });

    it("knows the user reference kind", () => {
        const tag = formatHappyReferenceTag({ kind: "user", id: USER });
        expect(tag).toBe(`<happy-user id="${USER}"/>`);
        expect(parseHappyReferenceTag(tag)).toEqual({ kind: "user", id: USER });
        expect(isKnownHappyReferenceKind("user")).toBe(true);
    });

    it("marks a task read through its route", async () => {
        const requests: { method: string; url: string; body: string | null }[] = [];
        const fetch: typeof globalThis.fetch = async (input, init) => {
            requests.push({
                body: typeof init?.body === "string" ? init.body : null,
                method: init?.method ?? "GET",
                url: input.toString(),
            });
            return Response.json({ task: null, membership: { ...membership, unread: null } });
        };
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });
        await client.markTaskRead("task1", { mutationId: "read-1" });
        await client.markTaskRead("task1");
        expect(requests).toEqual([
            {
                body: JSON.stringify({ mutationId: "read-1" }),
                method: "POST",
                url: "http://agent.local/v0/tasks/task1/read",
            },
            { body: "{}", method: "POST", url: "http://agent.local/v0/tasks/task1/read" },
        ]);
    });
});
