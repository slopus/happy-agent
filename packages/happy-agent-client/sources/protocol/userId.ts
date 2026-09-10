import { Type } from "@sinclair/typebox";

/** An installation-local Happy user identity, never a WorkOS identity. */
export const userIdSchema = Type.String({
    minLength: 2,
    maxLength: 32,
    pattern: "^[a-z][a-z0-9]*$",
});
