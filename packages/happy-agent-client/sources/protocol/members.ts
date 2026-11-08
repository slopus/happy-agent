import { type Static, Type } from "@sinclair/typebox";

/**
 * A team server's members and invites as its events report them; see "Team members" under
 * "Event types" in API.md. The standalone daemon sends none of these.
 */
export const teamMemberSchema = Type.Object({
    accountId: Type.String({ minLength: 1 }),
    /** A role ID from `GET /v0/roles`, such as `member`. */
    role: Type.String({ minLength: 1 }),
});
export type TeamMember = Static<typeof teamMemberSchema>;

/** An invite without its code, which only the response that created it shows. */
export const teamInviteSchema = Type.Object({
    id: Type.String({ minLength: 1 }),
    role: Type.String({ minLength: 1 }),
    /** When the invite stops working, as an RFC 3339 UTC time. */
    expiresAt: Type.String({ minLength: 1 }),
});
export type TeamInvite = Static<typeof teamInviteSchema>;

/** `member.updated`: a member joined or their role changed. */
export interface MemberUpdatedPayload {
    member: TeamMember;
    mutationId?: string;
}

/** `member.removed`: a member left or was removed. */
export interface MemberRemovedPayload {
    accountId: string;
}

/** `invite.created`: an invite was created; never its code. */
export interface InviteCreatedPayload {
    invite: TeamInvite;
    mutationId?: string;
}

/** `invite.removed`: an invite was revoked. */
export interface InviteRemovedPayload {
    inviteId: string;
}
