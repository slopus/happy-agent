import type { VaultRetention } from "@slopus/happy-agent-client";

const DAY = 24 * 60 * 60 * 1000;

/** What retention looks at in one version. */
export interface RetainedVersion {
    readonly number: number;
    readonly createdAt: number;
    readonly pinned: boolean;
}

/**
 * The numbers of an entry's versions that `policy` drops at `now`, in the order the API states:
 * the newest and pinned versions are always kept; `maxAgeDays` drops; `keepAllDays` keeps; the
 * tier with the largest `afterDays` not above a version's age keeps the newest version of the
 * tier in each epoch-aligned bucket of `everyDays`; `maxVersions` caps the survivors with the
 * newest counted. Buckets are aligned to the epoch, so applying a policy twice at one moment
 * drops nothing more.
 */
export function selectPrunedVersions(
    policy: VaultRetention,
    versions: readonly RetainedVersion[],
    now: number,
): number[] {
    if (versions.length === 0) return [];
    const newest = Math.max(...versions.map((version) => version.number));
    const candidates = versions
        .filter((version) => version.number !== newest && !version.pinned)
        .sort((left, right) => right.number - left.number);
    const dropped = new Set<number>();
    const survivors: RetainedVersion[] = [];
    /** The newest version already kept in each tier's bucket, by tier and bucket. */
    const keptBuckets = new Set<string>();
    for (const version of candidates) {
        const age = now - version.createdAt;
        if (policy.maxAgeDays !== null && age > policy.maxAgeDays * DAY) {
            dropped.add(version.number);
            continue;
        }
        if (age < policy.keepAllDays * DAY) {
            survivors.push(version);
            continue;
        }
        const tier = tierFor(policy, age);
        if (tier === undefined) {
            survivors.push(version);
            continue;
        }
        const bucket = `${String(tier.index)}:${String(Math.floor(version.createdAt / (tier.everyDays * DAY)))}`;
        // Candidates run newest first, so the first one seen in a bucket is its newest.
        if (keptBuckets.has(bucket)) {
            dropped.add(version.number);
            continue;
        }
        keptBuckets.add(bucket);
        survivors.push(version);
    }
    if (policy.maxVersions !== null) {
        for (const version of survivors.slice(Math.max(0, policy.maxVersions - 1)))
            dropped.add(version.number);
    }
    return [...dropped].sort((left, right) => left - right);
}

function tierFor(
    policy: VaultRetention,
    age: number,
): { readonly index: number; readonly everyDays: number } | undefined {
    let found: { index: number; everyDays: number } | undefined;
    for (const [index, tier] of policy.thinning.entries()) {
        if (tier.afterDays * DAY <= age) found = { index, everyDays: tier.everyDays };
    }
    return found;
}

/** Tiers must rise strictly; the schema cannot say so. */
export function retentionTiersIncrease(policy: VaultRetention): boolean {
    return policy.thinning.every(
        (tier, index) => index === 0 || tier.afterDays > policy.thinning[index - 1]!.afterDays,
    );
}
