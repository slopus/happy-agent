import { Type, type Static } from "@sinclair/typebox";
import { p2pInstanceIdSchema } from "./P2pIdentityProtocol.js";

const exact = { additionalProperties: false } as const;

export const happyAgentProfileIdSchema = Type.String({
    maxLength: 32,
    minLength: 2,
    pattern: "^[a-z][a-z0-9]+$",
});
export type HappyAgentProfileId = Static<typeof happyAgentProfileIdSchema>;
export const happyAgentProfileIdentitySchema = Type.Union([happyAgentProfileIdSchema, Type.Null()]);
export type HappyAgentProfileIdentity = Static<typeof happyAgentProfileIdentitySchema>;

export const happyAgentProfileNameSchema = Type.String({
    maxLength: 128,
    minLength: 1,
    pattern:
        "^[^\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b\\u200e\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f]+$",
});
export const happyAgentProfileEmailSchema = Type.String({
    maxLength: 254,
    minLength: 3,
    pattern: "^[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+$",
});

export const happyAgentProfilePhotoInputSchema = Type.Object(
    {
        data: Type.String({
            maxLength: 32 * 1024 * 1024,
            minLength: 1,
            pattern: "^[A-Za-z0-9+/]*={0,2}$",
        }),
        mediaType: Type.String({ maxLength: 128, minLength: 1 }),
    },
    exact,
);
export type HappyAgentProfilePhotoInput = Static<typeof happyAgentProfilePhotoInputSchema>;

export const happyAgentProfilePhotoSchema = Type.Object(
    {
        bytes: Type.Integer({ maximum: 96 * 1024, minimum: 1 }),
        data: Type.String({
            maxLength: 128 * 1024,
            minLength: 1,
            pattern: "^[A-Za-z0-9+/]*={0,2}$",
        }),
        height: Type.Integer({ maximum: 16_384, minimum: 1 }),
        mediaType: Type.Literal("image/webp"),
        thumbhash: Type.String({ maxLength: 1_024, minLength: 1 }),
        width: Type.Integer({ maximum: 16_384, minimum: 1 }),
    },
    exact,
);
export type HappyAgentProfilePhoto = Static<typeof happyAgentProfilePhotoSchema>;

export const happyAgentProfileSchema = Type.Object(
    {
        createdAt: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        email: happyAgentProfileEmailSchema,
        id: happyAgentProfileIdSchema,
        name: happyAgentProfileNameSchema,
        parentInstanceId: p2pInstanceIdSchema,
        photo: Type.Optional(happyAgentProfilePhotoSchema),
        updatedAt: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        version: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
    },
    exact,
);
export type HappyAgentProfile = Static<typeof happyAgentProfileSchema>;

export const createHappyAgentProfileRequestSchema = Type.Object(
    {
        email: happyAgentProfileEmailSchema,
        name: happyAgentProfileNameSchema,
        photo: Type.Optional(happyAgentProfilePhotoInputSchema),
    },
    exact,
);
export type CreateHappyAgentProfileRequest = Static<typeof createHappyAgentProfileRequestSchema>;

export const updateHappyAgentProfileRequestSchema = Type.Object(
    {
        email: Type.Optional(happyAgentProfileEmailSchema),
        name: Type.Optional(happyAgentProfileNameSchema),
        photo: Type.Optional(Type.Union([happyAgentProfilePhotoInputSchema, Type.Null()])),
    },
    { ...exact, minProperties: 1 },
);
export type UpdateHappyAgentProfileRequest = Static<typeof updateHappyAgentProfileRequestSchema>;

export const replicateHappyAgentProfileRequestSchema = Type.Object(
    { profile: happyAgentProfileSchema },
    exact,
);
export type ReplicateHappyAgentProfileRequest = Static<
    typeof replicateHappyAgentProfileRequestSchema
>;

export const listHappyAgentProfilesResponseSchema = Type.Object(
    { profiles: Type.Array(happyAgentProfileSchema, { maxItems: 128 }) },
    exact,
);
export type ListHappyAgentProfilesResponse = Static<typeof listHappyAgentProfilesResponseSchema>;

export const happyAgentProfileResponseSchema = Type.Object(
    { profile: happyAgentProfileSchema },
    exact,
);
export type HappyAgentProfileResponse = Static<typeof happyAgentProfileResponseSchema>;

export const happyAgentProfileChangedEventSchema = Type.Object(
    {
        createdAt: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        data: Type.Object(
            {
                profileId: happyAgentProfileIdSchema,
                version: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
            },
            exact,
        ),
        id: Type.String({ maxLength: 256, minLength: 1 }),
        type: Type.Literal("profile_changed"),
    },
    exact,
);
export type HappyAgentProfileChangedEvent = Static<typeof happyAgentProfileChangedEventSchema>;
