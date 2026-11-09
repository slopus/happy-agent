import { Value } from "@sinclair/typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { HappyAgentEvent } from "../sources/protocol/events.js";
import {
    gitCredentialSchema,
    teamInviteSchema,
    teamMemberSchema,
    type GitCredential,
} from "../sources/protocol/members.js";

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

describe("a team server's compute and Git credential events", () => {
    it("are events a client can follow, with the payloads the server sends", () => {
        expectTypeOf<PayloadOf<"compute.nodes.updated">>().toEqualTypeOf<Record<string, never>>();
        expectTypeOf<PayloadOf<"compute.pools.updated">>().toEqualTypeOf<Record<string, never>>();
        expectTypeOf<PayloadOf<"gitCredential.created">>().toEqualTypeOf<{
            credential: GitCredential;
            mutationId?: string;
        }>();
        expectTypeOf<PayloadOf<"gitCredential.updated">>().toEqualTypeOf<{
            credentialId: string;
            previousVersion: string;
            version: string;
            changes: GitCredential;
        }>();
        expectTypeOf<PayloadOf<"gitCredential.deleted">>().toEqualTypeOf<{
            credentialId: string;
        }>();
    });

    it("read a credential as the server lists it, never with its secret", () => {
        const credential = {
            id: "c1",
            version: "v1",
            name: "GitHub",
            kind: "oauth",
            transport: "https",
            shared: false,
            ownerUserId: "u1",
            hosts: ["github.com"],
            repos: [],
            operations: ["read", "write"],
            createdBy: "u1",
            createdAt: 1,
            updatedAt: 2,
            lastUsedAt: null,
            username: "ada",
            provider: "github",
        };
        expect(Value.Check(gitCredentialSchema, credential)).toBe(true);
        for (const secret of ["token", "privateKey", "secret"]) {
            expect(Object.keys(gitCredentialSchema.properties)).not.toContain(secret);
        }
    });
});
