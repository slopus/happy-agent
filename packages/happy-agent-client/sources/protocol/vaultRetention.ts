/**
 * A vault's retention policy: which earlier versions of its files it keeps, and how long its
 * Trash holds what was deleted. Kept apart from the rest of the vault protocol so Surface
 * creation can name it without an import cycle.
 */

import { type Static, Type } from "@sinclair/typebox";

import { Nullable } from "./common.js";

const days = (minimum: number, maximum: number) => Type.Integer({ minimum, maximum });

/** After `afterDays`, keep one version in every `everyDays`, in buckets counted from the epoch. */
export const vaultRetentionTierSchema = Type.Object(
    { afterDays: days(0, 36_500), everyDays: days(1, 3_650) },
    { additionalProperties: false },
);
export type VaultRetentionTier = Static<typeof vaultRetentionTierSchema>;

/**
 * The newest and pinned versions are always kept. Then `maxAgeDays` drops, `keepAllDays` keeps,
 * the tier with the largest `afterDays` not above a version's age thins, and `maxVersions` caps
 * what survived, the newest included. The daemon also requires strictly increasing `afterDays`.
 */
export const vaultRetentionSchema = Type.Object(
    {
        keepAllDays: days(0, 36_500),
        maxAgeDays: Nullable(days(1, 36_500)),
        maxVersions: Nullable(Type.Integer({ minimum: 1, maximum: 10_000 })),
        thinning: Type.Array(vaultRetentionTierSchema, { maxItems: 8 }),
        /** Days a Trash item stays before it is removed for good; `null` keeps it. */
        trashDays: Nullable(days(1, 3_650)),
    },
    { additionalProperties: false },
);
export type VaultRetention = Static<typeof vaultRetentionSchema>;

/** Every version for a week, one a day until 30 days, one a week after, no cap, 30-day Trash. */
export const DEFAULT_VAULT_RETENTION: VaultRetention = {
    keepAllDays: 7,
    maxAgeDays: null,
    maxVersions: null,
    thinning: [
        { afterDays: 7, everyDays: 1 },
        { afterDays: 30, everyDays: 7 },
    ],
    trashDays: 30,
};
