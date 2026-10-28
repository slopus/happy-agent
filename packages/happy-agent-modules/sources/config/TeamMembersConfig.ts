import { Type, type Static } from "@sinclair/typebox";

import { teamOwnerUserIdSchema } from "./TeamJwtConfig.js";

const exact = { additionalProperties: false } as const;
const describedPattern =
    "^(?=.*\\S)[^\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b\\u200e\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f]+$";
const nameSchema = Type.String({ minLength: 1, maxLength: 128, pattern: describedPattern });
const emailSchema = Type.String({
    minLength: 3,
    maxLength: 254,
    pattern: "^[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+$",
});
const roleSchema = Type.String({ minLength: 1, maxLength: 64, pattern: describedPattern });
const followsSchema = Type.String({ minLength: 1, maxLength: 500, pattern: describedPattern });

/**
 * `[feature.team.members.<subject>]`: a team member created before they first sign in, keyed by
 * the user ID their sign-in method proves (the JWT user claim, or a WorkOS user ID).
 */
export const teamMemberTomlSchema = Type.Object(
    {
        name: nameSchema,
        email: Type.Optional(emailSchema),
        role: Type.Optional(roleSchema),
        follows: Type.Optional(followsSchema),
        /** `false` makes the member's `tasks.autoJoin` setting start disabled. */
        auto_join_tasks: Type.Optional(Type.Boolean()),
    },
    exact,
);

export const teamMembersTomlSchema = Type.Record(teamOwnerUserIdSchema, teamMemberTomlSchema, {
    maxProperties: 256,
});

export const teamMemberConfigSchema = Type.Object(
    {
        name: nameSchema,
        email: Type.Optional(emailSchema),
        role: Type.Optional(roleSchema),
        follows: Type.Optional(followsSchema),
        autoJoinTasks: Type.Optional(Type.Boolean()),
    },
    exact,
);
export type TeamMemberConfig = Static<typeof teamMemberConfigSchema>;

export const teamMembersConfigSchema = Type.Record(teamOwnerUserIdSchema, teamMemberConfigSchema, {
    maxProperties: 256,
});

export function resolveTeamMembersConfig(
    members: Static<typeof teamMembersTomlSchema>,
): Record<string, TeamMemberConfig> {
    return Object.fromEntries(
        Object.entries(members).map(([subject, member]) => [
            subject,
            {
                name: member.name,
                ...(member.email === undefined ? {} : { email: member.email }),
                ...(member.role === undefined ? {} : { role: member.role }),
                ...(member.follows === undefined ? {} : { follows: member.follows }),
                ...(member.auto_join_tasks === undefined
                    ? {}
                    : { autoJoinTasks: member.auto_join_tasks }),
            },
        ]),
    );
}
