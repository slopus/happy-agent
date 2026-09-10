import { Type, type Static } from "@sinclair/typebox";

import { Nullable, resourceVersionSchema, timestampSchema } from "./common.js";
import { profilePhotoSchema } from "./profile.js";

/** An installation-local Happy user identity, never a WorkOS identity. */
export const userIdSchema = Type.String({
    minLength: 2,
    maxLength: 32,
    pattern: "^[a-z][a-z0-9]*$",
});

/** The bounded batch accepted by the team-user lookup, in caller order. */
export const userIdsSchema = Type.Array(userIdSchema, { maxItems: 100 });
export type UserIds = Static<typeof userIdsSchema>;

/** Public display information for one installation-local team member. */
export const userSchema = Type.Object({
    id: userIdSchema,
    name: Type.String({ minLength: 1 }),
    photo: Nullable(profilePhotoSchema),
    updatedAt: timestampSchema,
    version: resourceVersionSchema,
});
export type User = Static<typeof userSchema>;

/** `GET /v0/users` — known users in first-requested order, without duplicates. */
export const usersResponseSchema = Type.Object({
    users: Type.Array(userSchema, { maxItems: 100 }),
});
export type UsersResponse = Static<typeof usersResponseSchema>;
