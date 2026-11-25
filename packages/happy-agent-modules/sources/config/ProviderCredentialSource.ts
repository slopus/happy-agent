import { Type, type Static } from "@sinclair/typebox";

/**
 * Where an account's credential comes from: one this installation owns (`internal`), the
 * machine's own sign-in or environment (`system`), or one configuration names (`configured`).
 */
export const providerCredentialSourceSchema = Type.Union([
    Type.Literal("internal"),
    Type.Literal("system"),
    Type.Literal("configured"),
]);
export type ProviderCredentialSource = Static<typeof providerCredentialSourceSchema>;
