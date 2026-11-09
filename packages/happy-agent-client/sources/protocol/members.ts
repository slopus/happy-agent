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

/**
 * `compute.nodes.updated` and `compute.pools.updated`: a team server's compute nodes or pools
 * changed. Each is a notice to read them again, with no data; pools changing always follows a
 * nodes notice in the same transaction.
 */
export type ComputeUpdatedPayload = Record<string, never>;

/** A team server's Git credential as `GET /v0/git/credentials` returns it; never its secret. */
export const gitCredentialSchema = Type.Object({
    id: Type.String({ minLength: 1 }),
    version: Type.String({ minLength: 1 }),
    name: Type.String(),
    kind: Type.Union([
        Type.Literal("https_token"),
        Type.Literal("github_app"),
        Type.Literal("oauth"),
        Type.Literal("ssh_key"),
    ]),
    transport: Type.Union([Type.Literal("https"), Type.Literal("ssh")]),
    /** True for a team credential, which has no owner. */
    shared: Type.Boolean(),
    ownerUserId: Type.Union([Type.String(), Type.Null()]),
    hosts: Type.Array(Type.String()),
    repos: Type.Array(Type.String()),
    operations: Type.Array(
        Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("sign")]),
    ),
    ports: Type.Optional(Type.Array(Type.Integer())),
    createdBy: Type.String(),
    /** Unix milliseconds. */
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
    lastUsedAt: Type.Union([Type.Number(), Type.Null()]),
    username: Type.Optional(Type.String()),
    scheme: Type.Optional(Type.String()),
    appId: Type.Optional(Type.Integer()),
    installationId: Type.Optional(Type.Integer()),
    /** `github` for a credential a device sign-in made. */
    provider: Type.Optional(Type.String()),
    publicKey: Type.Optional(Type.String()),
    fingerprint: Type.Optional(Type.String()),
    knownHosts: Type.Optional(Type.Array(Type.String())),
});
export type GitCredential = Static<typeof gitCredentialSchema>;

/**
 * `gitCredential.created`: a Git credential was added, by request or when a device sign-in
 * finished. A personal credential's event reaches only its owner.
 */
export interface GitCredentialCreatedPayload {
    credential: GitCredential;
    mutationId?: string;
}

/** `gitCredential.updated`: a Git credential changed; `changes` is the whole credential after. */
export interface GitCredentialUpdatedPayload {
    credentialId: string;
    previousVersion: string;
    version: string;
    changes: GitCredential;
}

/** `gitCredential.deleted`: a Git credential was removed. */
export interface GitCredentialDeletedPayload {
    credentialId: string;
}
