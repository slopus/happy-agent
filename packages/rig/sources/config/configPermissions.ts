import { Type, type Static } from "@sinclair/typebox";

export const protectedPathsSchema = Type.Array(
    Type.String({
        maxLength: 512,
        minLength: 1,
        pattern: "^(?!/)(?!~(?:/|$))(?!.*(?:^|/)\\.\\.(?:/|$))[^\\\\\\r\\n]+$",
    }),
    { maxItems: 128, uniqueItems: true },
);

export const configPermissionsSchema = Type.Object({
    protectedPaths: protectedPathsSchema,
});

export const partialConfigPermissionsSchema = Type.Partial(configPermissionsSchema);

export type ConfigPermissions = Static<typeof configPermissionsSchema>;
export type PartialConfigPermissions = Static<typeof partialConfigPermissionsSchema>;
