import { Type, type Static } from "@sinclair/typebox";
import { profileEmailSchema, profileNameSchema } from "./ProfileTypes.js";

/** Only the public fields needed to bootstrap another standalone installation. */
export const localProfileSchema = Type.Object(
    { name: profileNameSchema, email: profileEmailSchema },
    { additionalProperties: false },
);
export type LocalProfile = Static<typeof localProfileSchema>;
