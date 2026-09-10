import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    HappyAgentClient,
    messageMetadataSchema,
    userIdsSchema,
    usersResponseSchema,
    type User,
} from "../sources/index.js";

const user: User = {
    id: "alice123",
    name: "Alice Example",
    photo: null,
    version: "01900000-0000-7000-8000-000000000001",
    updatedAt: 1,
};

describe("team authorship and user lookup", () => {
    it("adds optional authenticated provenance while tolerating older and future metadata", () => {
        for (const metadata of [{}, { userId: user.id }, { userId: user.id, futureField: true }]) {
            expect(Value.Check(messageMetadataSchema, metadata)).toBe(true);
        }
        for (const userId of [null, 42, "", "user_workos"]) {
            expect(Value.Check(messageMetadataSchema, { userId })).toBe(false);
        }
    });

    it("bounds lookup batches without requiring unique or existing IDs", () => {
        expect(Value.Check(userIdsSchema, [])).toBe(true);
        expect(Value.Check(userIdsSchema, Array(100).fill(user.id))).toBe(true);
        expect(Value.Check(userIdsSchema, Array(101).fill(user.id))).toBe(false);
        expect(Value.Check(userIdsSchema, ["user_workos"])).toBe(false);
        expect(Value.Check(usersResponseSchema, { users: [user] })).toBe(true);
        expect(Value.Check(usersResponseSchema, { users: [] })).toBe(true);
        expect(Value.Check(usersResponseSchema, { users: [{ ...user, name: null }] })).toBe(false);
    });

    it("looks up users through the authenticated remote path with cancellation", async () => {
        const controller = new AbortController();
        const client = new HappyAgentClient({
            endpoint: "http://main/prefix?key=transport",
            token: "main-token",
            fetch: async (input, init) => {
                const url = new URL(input.toString());
                expect(url.pathname).toBe("/prefix/v0/connections/team/api/v0/users");
                expect(url.searchParams.get("ids")).toBe("alice123,unknown123,alice123");
                expect(url.searchParams.get("key")).toBe("transport");
                expect(init?.method).toBe("GET");
                expect(init?.signal).toBe(controller.signal);
                expect(new Headers(init?.headers).get("authorization")).toBe("Bearer main-token");
                return Response.json({ users: [user] });
            },
        });
        await expect(
            client.connection("team").getUsers([user.id, "unknown123", user.id], {
                signal: controller.signal,
            }),
        ).resolves.toEqual({ users: [user] });
    });

    it("sends an empty batch explicitly and rejects invalid input before transport", async () => {
        let calls = 0;
        const client = new HappyAgentClient({
            endpoint: "http://main",
            token: "t",
            fetch: async (input) => {
                calls++;
                expect(new URL(input.toString()).searchParams.get("ids")).toBe("");
                return Response.json({ users: [] });
            },
        });
        await expect(client.getUsers([])).resolves.toEqual({ users: [] });
        await expect(client.getUsers(Array(101).fill(user.id))).rejects.toThrow("at most 100");
        await expect(client.getUsers(["user_workos"])).rejects.toThrow("valid Happy user IDs");
        expect(calls).toBe(1);
    });

    it.each([401, 404, 503])("preserves HTTP %i errors without retries", async (status) => {
        let calls = 0;
        const client = new HappyAgentClient({
            endpoint: "http://main",
            token: "t",
            fetch: async () => {
                calls++;
                return Response.json({ code: "not_found", error: "Unavailable." }, { status });
            },
        });
        await expect(client.getUsers([user.id])).rejects.toMatchObject({ status });
        expect(calls).toBe(1);
    });
});
