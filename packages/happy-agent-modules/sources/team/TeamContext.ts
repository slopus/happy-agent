import { createContextNamespace, type Context } from "@steve.kite/stdlib";

import type { TeamUser } from "./TeamUser.js";

export interface TeamIdentity {
    readonly organizationId: string;
    readonly workosUserId: string;
}

const teamIdentityNamespace = createContextNamespace<TeamIdentity | undefined>(
    "happyAgent.teamIdentity",
    undefined,
    { detachable: false },
);

const teamUserNamespace = createContextNamespace<TeamUser | undefined>(
    "happyAgent.teamUser",
    undefined,
    { detachable: false },
);

/** Derive the bounded request context carrying its authenticated team user. */
export function withTeamUser(ctx: Context, user: TeamUser): Context {
    return teamUserNamespace.set(ctx, user);
}

/** Derive a request context carrying the locally verified WorkOS identity. */
export function withTeamIdentity(ctx: Context, identity: TeamIdentity): Context {
    return teamIdentityNamespace.set(ctx, identity);
}

/** The verified WorkOS identity for this request, even before local onboarding. */
export function teamIdentity(ctx: Context): TeamIdentity | undefined {
    return teamIdentityNamespace.get(ctx);
}

/** The authenticated team user for this request, when team authentication supplied one. */
export function teamUser(ctx: Context): TeamUser | undefined {
    return teamUserNamespace.get(ctx);
}
