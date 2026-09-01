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

export const teamUserEmailSchema = Type.Union([
    Type.String({
        maxLength: 254,
        minLength: 3,
        pattern: "^[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+$",
    }),
    Type.Null(),
]);

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
        workosUserId: workOSUserIdSchema,
    },
    exact,
);
export type TeamUser = Static<typeof teamUserSchema>;

export const createTeamUserInputSchema = Type.Object(
    {
        email: Type.Optional(teamUserEmailSchema),
        firstName: teamUserNameSchema,
        lastName: Type.Optional(Type.Union([teamUserNameSchema, Type.Null()])),
        workosUserId: workOSUserIdSchema,
    },
    exact,
);
export type CreateTeamUserInput = Static<typeof createTeamUserInputSchema>;

export const updateTeamProfileInputSchema = Type.Object(
    {
        email: Type.Optional(teamUserEmailSchema),
        name: Type.Optional(Type.Union([teamUserNameSchema, Type.Null()])),
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
