import { agentDatabaseRows } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import { teamUserAuthenticationSchema, teamUserSchema, type TeamUser } from "../TeamUser.js";

const filterSchema = Type.Object({
    id: Type.Optional(Type.String()),
    ids: Type.Optional(Type.Array(Type.String())),
    authentication: Type.Optional(Type.String()),
    subject: Type.Optional(Type.String()),
    /** Only people who can sign in, leaving guests out. */
    membersOnly: Type.Optional(Type.Boolean()),
});

const storedUserRowSchema = Type.Object(
    {
        content_hash: Type.Union([Type.String(), Type.Null()]),
        created_at: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        email: Type.Union([Type.String(), Type.Null()]),
        first_name: Type.String(),
        height: Type.Union([Type.Integer(), Type.Null()]),
        id: Type.String(),
        is_owner: Type.Integer({ maximum: 1, minimum: 0 }),
        last_name: Type.Union([Type.String(), Type.Null()]),
        profile_version: Type.String(),
        thumbhash: Type.Union([Type.String(), Type.Null()]),
        updated_at: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        width: Type.Union([Type.Integer(), Type.Null()]),
        authentication: teamUserAuthenticationSchema,
        subject: Type.String(),
        role: Type.Union([Type.String(), Type.Null()]),
        follows: Type.Union([Type.String(), Type.Null()]),
    },
    { additionalProperties: false },
);

/** Read complete users and bounded photo metadata in the caller's database transaction. */
export async function queryTeamUsers(
    ctx: Context,
    filter: Static<typeof filterSchema> = {},
): Promise<readonly TeamUser[]> {
    if (filter.ids?.length === 0) return [];
    const predicates = [sql`1 = 1`];
    if (filter.id !== undefined) predicates.push(sql`u.id = ${filter.id}`);
    if (filter.authentication !== undefined)
        predicates.push(sql`u.authentication = ${filter.authentication}`);
    if (filter.subject !== undefined) predicates.push(sql`u.subject = ${filter.subject}`);
    if (filter.membersOnly === true) predicates.push(sql`u.authentication <> 'guest'`);
    if (filter.ids !== undefined)
        predicates.push(
            sql`u.id IN (${sql.join(
                filter.ids.map((id) => sql`${id}`),
                sql`, `,
            )})`,
        );
    const rows = await agentDatabaseRows<unknown>(
        ctx.db,
        sql`
        SELECT u.id, u.authentication, u.subject, u.first_name, u.last_name, u.is_owner, u.email,
            u.profile_version, u.created_at, u.updated_at, u.role, u.follows,
            p.content_hash, p.thumbhash, p.width, p.height
        FROM happy_agent_team_users u
        LEFT JOIN happy_agent_team_user_photos p ON p.user_id = u.id
        WHERE ${sql.join(predicates, sql` AND `)}
        ORDER BY u.id
    `,
    );
    return rows.map((value) => {
        if (!Value.Check(storedUserRowSchema, value))
            throw new Error("A stored team user is invalid.");
        const photo =
            value.content_hash === null ||
            value.thumbhash === null ||
            value.width === null ||
            value.height === null
                ? null
                : {
                      contentHash: value.content_hash,
                      height: value.height,
                      thumbhash: value.thumbhash,
                      width: value.width,
                  };
        const user: TeamUser = {
            createdAt: value.created_at,
            email: value.email,
            firstName: value.first_name,
            id: value.id,
            isOwner: value.is_owner === 1,
            lastName: value.last_name,
            photo,
            updatedAt: value.updated_at,
            version: value.profile_version,
            authentication: value.authentication,
            subject: value.subject,
            ...(value.role === null ? {} : { role: value.role }),
            ...(value.follows === null ? {} : { follows: value.follows }),
        };
        if (!Value.Check(teamUserSchema, user)) throw new Error("A stored team user is invalid.");
        return user;
    });
}
