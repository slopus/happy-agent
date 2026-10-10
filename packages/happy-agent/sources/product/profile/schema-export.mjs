import * as original from "../../../../happy-agent-modules/sources/profile/ProfileTypes.ts";
import { localProfileSchema } from "../../../../happy-agent-modules/sources/profile/LocalProfile.ts";
import { getLocalProfileTool } from "../../../../happy-agent-modules/sources/profile/tools/get_local_profile.ts";
import { createProfileVersion } from "../../../../happy-agent-modules/sources/profile/createProfileVersion.ts";
import { rgbaToThumbHash } from "../../../../happy-agent-modules/sources/profile/rgbaToThumbHash.ts";
import { profileResource } from "../../../../happy-agent-modules/sources/api/ApiResourceProjection.ts";
import { profilePatchBodySchema } from "../../../../happy-agent-modules/sources/api/ApiSchemas.ts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { writeFileSync } from "node:fs";
export const profileTools = [getLocalProfileTool(undefined, "source-agent")];
export const profileSchemas = {
    ownerProfile: original.profileSchema,
    ownerProfileCreate: original.createProfileInputSchema,
    ownerProfileUpdate: original.updateProfileInputSchema,
    ownerProfileId: original.profileIdSchema,
    ownerProfileVersion: original.profileVersionSchema,
    ownerProfileInstanceId: original.instanceIdSchema,
    ownerProfileMutationOptions: original.profileMutationOptionsSchema,
    ownerProfilePhotoType: original.profilePhotoContentTypeSchema,
    ownerProfilePhotoMetadata: original.profilePhotoMetadataSchema,
    ownerProfilePhotoAssetMetadata: Type.Omit(original.profilePhotoAssetSchema, ["bytes"]),
    ownerProfileLocal: localProfileSchema,
    ownerProfileChanged: original.profileChangedEventSchema,
    ownerProfilePatch: profilePatchBodySchema,
    ownerProfilePatchFields: Type.Omit(profilePatchBodySchema, ["mutationId"]),
    ownerTool_get_local_profile: profileTools[0].parameters,
};
const cases = [
    { schema: "ownerProfileUpdate", value: { name: "Ada Lovelace", email: "ada@example.test" } },
    { schema: "ownerProfileUpdate", value: { name: "😀".repeat(64) } },
    { schema: "ownerProfileUpdate", value: { name: "😀".repeat(65) } },
    { schema: "ownerProfileUpdate", value: { name: "Misleading\u202ename" } },
    { schema: "ownerProfileUpdate", value: { email: "missing-at.example.test" } },
    { schema: "ownerProfileUpdate", value: {} },
    { schema: "ownerProfileUpdate", value: { name: null, email: null } },
];
const versions = [
    { previous: "00000000-03e8-7000-8000-000000000000", now: 1000 },
    { previous: "00000000-03e8-7000-8000-000000000000", now: 999 },
    { previous: "00000000-03e8-7fff-bfff-ffffffffffff", now: 999 },
];
const privateProfile = {
    createdAt: 1000,
    email: "ada@example.test",
    id: "profilefixture",
    name: "Ada Lovelace",
    parentInstanceId: "fixture-installation",
    photo: null,
    updatedAt: 1000,
    version: "00000000-03e8-7000-8000-000000000000",
};
writeFileSync(
    new URL("source_goldens.json", import.meta.url),
    `${JSON.stringify(
        {
            validations: cases.map(({ schema, value }) => ({
                schema,
                value,
                valid: Value.Check(profileSchemas[schema], value),
            })),
            versions: versions.map(({ previous, now }) => ({
                previous,
                now,
                result: createProfileVersion(previous, () => now),
            })),
            projections: [
                { profile: privateProfile, result: profileResource(privateProfile) },
                { profile: null, result: profileResource(undefined) },
            ],
            thumbhashes: [
                { width: 1, height: 1, rgba: [255, 0, 0, 255] },
                { width: 2, height: 1, rgba: [255, 0, 0, 255, 0, 255, 0, 128] },
                { width: 1, height: 1, rgba: [0, 0, 0, 0] },
            ].map(({ width, height, rgba }) => ({
                width,
                height,
                rgba,
                result: Buffer.from(rgbaToThumbHash(width, height, new Uint8Array(rgba))).toString(
                    "base64",
                ),
            })),
        },
        null,
        2,
    )}\n`,
);
