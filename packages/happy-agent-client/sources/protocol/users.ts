import { Type, type Static } from "@sinclair/typebox";

import { Nullable, resourceVersionSchema, timestampSchema } from "./common.js";
import { profilePhotoSchema } from "./profile.js";
import { userIdSchema } from "./userId.js";

export { userIdSchema } from "./userId.js";

/** The bounded batch accepted by the team-user lookup, in caller order. */
export const userIdsSchema = Type.Array(userIdSchema, { maxItems: 100 });
export type UserIds = Static<typeof userIdsSchema>;

/**
 * `"member"` for an organization member who signs in; `"guest"` for a person who reaches an
 * exported bot from an outside chat service and has no credentials.
 */
export const userKindSchema = Type.Union([Type.Literal("member"), Type.Literal("guest")]);
export type UserKind = Static<typeof userKindSchema>;

/** Public display information for one installation-local team member or exported-bot guest. */
export const userSchema = Type.Object({
    id: userIdSchema,
    name: Type.String({ minLength: 1 }),
    photo: Nullable(profilePhotoSchema),
    updatedAt: timestampSchema,
    version: resourceVersionSchema,
    /** Older daemons omit it; treat a missing kind as `"member"`. */
    kind: Type.Optional(userKindSchema),
    /** `false` for a guest, who cannot sign in. Older daemons omit it; treat it as `true`. */
    canLogIn: Type.Optional(Type.Boolean()),
    /** What the member does, such as "designer"; `null` when unset. Older daemons omit it. */
    role: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 64 }))),
    /** What the member follows, such as "all voice features"; `null` when unset. */
    follows: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 500 }))),
});
export type User = Static<typeof userSchema>;

/** `GET /v0/users` — known users in first-requested order, without duplicates. */
export const usersResponseSchema = Type.Object({
    users: Type.Array(userSchema, { maxItems: 100 }),
});
export type UsersResponse = Static<typeof usersResponseSchema>;
