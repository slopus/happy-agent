import { Value } from "@sinclair/typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { HappyAgentEvent } from "../sources/protocol/events.js";
import { teamInviteSchema, teamMemberSchema } from "../sources/protocol/members.js";

type PayloadOf<Type extends HappyAgentEvent["type"]> = Extract<
    HappyAgentEvent,
    { type: Type }
>["payload"];

describe("a team server's member and invite events", () => {
    it("are events a client can follow, with the payloads the server sends", () => {
        expectTypeOf<PayloadOf<"member.updated">>().toEqualTypeOf<{
            member: { accountId: string; role: string };
            mutationId?: string;
        }>();
        expectTypeOf<PayloadOf<"member.removed">>().toEqualTypeOf<{ accountId: string }>();
        expectTypeOf<PayloadOf<"invite.created">>().toEqualTypeOf<{
            invite: { id: string; role: string; expiresAt: string };
            mutationId?: string;
        }>();
        expectTypeOf<PayloadOf<"invite.removed">>().toEqualTypeOf<{ inviteId: string }>();
    });

    it("never take an invite's code as part of the invite", () => {
        const invite = { id: "i1", role: "member", expiresAt: "2026-11-14T00:00:00Z" };
        expect(Value.Check(teamInviteSchema, invite)).toBe(true);
        expect(Value.Check(teamMemberSchema, { accountId: "a1", role: "admin" })).toBe(true);
        expect(Value.Check(teamMemberSchema, { accountId: "", role: "admin" })).toBe(false);
        expect(Object.keys(teamInviteSchema.properties)).not.toContain("code");
    });
});
