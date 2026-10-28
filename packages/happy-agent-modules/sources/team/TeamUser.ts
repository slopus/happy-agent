import { cuid2Schema } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;
const timestampSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 });

export const teamUserNameSchema = Type.String({
    maxLength: 128,
    minLength: 1,
    pattern:
        "^[^\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b\\u200e\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f]+$",
});

export const workOSUserIdSchema = Type.String({
    maxLength: 160,
    minLength: 7,
    pattern: "^user_[A-Za-z0-9]+$",
});

/** The team authentication method that proved an identity. */
export const teamAuthenticationSchema = Type.Union([Type.Literal("workos"), Type.Literal("jwt")]);
export type TeamAuthentication = Static<typeof teamAuthenticationSchema>;

/**
 * How a stored user came to exist: a member proved by a sign-in method, or `guest`, a person who
 * reaches an exported bot from an outside chat service. No sign-in method ever yields `guest`, so
 * a guest has no way to authenticate.
 */
export const teamUserAuthenticationSchema = Type.Union([
    teamAuthenticationSchema,
    Type.Literal("guest"),
]);
export type TeamUserAuthentication = Static<typeof teamUserAuthenticationSchema>;

/** A user ID issued by the authentication method; unique only within that method. */
export const teamSubjectSchema = Type.String({
    maxLength: 256,
    minLength: 1,
    pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]+$",
});

export const teamUserEmailSchema = Type.Union([
    Type.String({
        maxLength: 254,
        minLength: 3,
        pattern: "^[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+$",
    }),
    Type.Null(),
]);

const teamDescriptionPattern =
    "^(?=.*\\S)[^\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b\\u200e\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f]+$";

/** What a member does on the team, in their words, such as "designer". */
export const teamUserRoleSchema = Type.String({
    maxLength: 64,
    minLength: 1,
    pattern: teamDescriptionPattern,
});

/** The work a member wants to hear about, in their words, such as "all voice features". */
export const teamUserFollowsSchema = Type.String({
    maxLength: 500,
    minLength: 1,
    pattern: teamDescriptionPattern,
});

export const teamUserVersionSchema = Type.String({
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});

export const teamUserPhotoMetadataSchema = Type.Object(
    {
        contentHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
        height: Type.Integer({ maximum: 512, minimum: 1 }),
        thumbhash: Type.String({ maxLength: 128, minLength: 4 }),
        width: Type.Integer({ maximum: 512, minimum: 1 }),
    },
    exact,
);
export type TeamUserPhotoMetadata = Static<typeof teamUserPhotoMetadataSchema>;

export const teamUserSchema = Type.Object(
    {
        createdAt: timestampSchema,
        email: teamUserEmailSchema,
        firstName: teamUserNameSchema,
        id: cuid2Schema,
        isOwner: Type.Boolean(),
        lastName: Type.Union([teamUserNameSchema, Type.Null()]),
        photo: Type.Union([teamUserPhotoMetadataSchema, Type.Null()]),
        updatedAt: timestampSchema,
        version: teamUserVersionSchema,
        authentication: teamUserAuthenticationSchema,
        subject: teamSubjectSchema,
        /** Absent until the member says what they do. */
        role: Type.Optional(teamUserRoleSchema),
        /** Absent until the member says what they follow. */
        follows: Type.Optional(teamUserFollowsSchema),
    },
    exact,
);
export type TeamUser = Static<typeof teamUserSchema>;

/** Whether a user is a guest, who has no credentials and can never sign in. */
export function isTeamGuest(user: TeamUser): boolean {
    return user.authentication === "guest";
}

/** A guest as an exported bot names them. Characters a team name forbids are dropped. */
export const createTeamGuestInputSchema = Type.Object(
    { name: Type.String({ minLength: 1, maxLength: 256 }) },
    exact,
);
export type CreateTeamGuestInput = Static<typeof createTeamGuestInputSchema>;

export const createTeamUserInputSchema = Type.Object(
    {
        email: Type.Optional(teamUserEmailSchema),
        firstName: teamUserNameSchema,
        lastName: Type.Optional(Type.Union([teamUserNameSchema, Type.Null()])),
        authentication: teamAuthenticationSchema,
        subject: teamSubjectSchema,
        role: Type.Optional(teamUserRoleSchema),
        follows: Type.Optional(teamUserFollowsSchema),
    },
    exact,
);
export type CreateTeamUserInput = Static<typeof createTeamUserInputSchema>;

export const updateTeamProfileInputSchema = Type.Object(
    {
        email: Type.Optional(teamUserEmailSchema),
        name: Type.Optional(Type.Union([teamUserNameSchema, Type.Null()])),
        role: Type.Optional(Type.Union([teamUserRoleSchema, Type.Null()])),
        follows: Type.Optional(Type.Union([teamUserFollowsSchema, Type.Null()])),
    },
    { ...exact, minProperties: 1 },
);
export type UpdateTeamProfileInput = Static<typeof updateTeamProfileInputSchema>;

export const preprocessedTeamUserPhotoSchema = Type.Object(
    {
        bytes: Type.Uint8Array({ maxByteLength: 8 * 1024 * 1024, minByteLength: 1 }),
        contentType: Type.Literal("image/webp"),
        height: Type.Integer({ maximum: 512, minimum: 1 }),
        thumbhash: Type.String({ maxLength: 128, minLength: 4 }),
        width: Type.Integer({ maximum: 512, minimum: 1 }),
    },
    exact,
);
export type PreprocessedTeamUserPhoto = Static<typeof preprocessedTeamUserPhotoSchema>;

export const teamUserPhotoAssetSchema = Type.Composite([
    preprocessedTeamUserPhotoSchema,
    Type.Object(
        {
            contentHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
            etag: Type.String({ maxLength: 80, minLength: 66 }),
        },
        exact,
    ),
]);
export type TeamUserPhotoAsset = Static<typeof teamUserPhotoAssetSchema>;
