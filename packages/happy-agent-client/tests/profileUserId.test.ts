import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    HappyAgentClient,
    desktopBootstrapResponseSchema,
    profileResponseSchema,
    profileSchema,
    type Profile,
} from "../sources/index.js";

const profile = {
    name: "Alice Example",
    email: "alice@example.test",
    photo: null,
    version: "01900000-0000-7000-8000-000000000001",
    updatedAt: 1,
} satisfies Profile;
const bootstrapProfileSchema = Type.Pick(desktopBootstrapResponseSchema, ["profile"]);

describe("current profile user ID", () => {
    it.each([
        { ...profile, userId: "alice123" },
        { ...profile, userId: null },
        profile,
        { ...profile, name: null, email: null, userId: null },
    ])(
        "uses the same additive profile contract in direct responses and bootstrap %#",
        (current) => {
            expect(desktopBootstrapResponseSchema.properties.profile).toEqual(profileSchema);
            expect(Value.Check(profileResponseSchema, { profile: current })).toBe(true);
            expect(Value.Check(bootstrapProfileSchema, { profile: current })).toBe(true);
        },
    );

    it.each(["", "user_workos", 42, {}, "a".repeat(33)])(
        "rejects invalid user IDs %#",
        (userId) => {
            const response = { profile: { ...profile, userId } };
            expect(Value.Check(profileResponseSchema, response)).toBe(false);
            expect(Value.Check(bootstrapProfileSchema, response)).toBe(false);
        },
    );

    it("returns the same authenticated identity from the profile and desktop bootstrap clients", async () => {
        const current: Profile = { ...profile, userId: "alice123" };
        const paths: string[] = [];
        const client = new HappyAgentClient({
            endpoint: "http://team",
            token: "alice-token",
            fetch: async (input, init) => {
                paths.push(new URL(input.toString()).pathname);
                expect(new Headers(init?.headers).get("authorization")).toBe("Bearer alice-token");
                return Response.json({ profile: current });
            },
        });
        const direct = await client.getProfile();
        const bootstrap = await client.getDesktopBootstrap();
        expect(direct.profile).toEqual(current);
        expect(bootstrap.profile).toEqual(direct.profile);
        expect(paths).toEqual(["/v0/profile", "/v0/bootstrap/desktop"]);
    });
});
