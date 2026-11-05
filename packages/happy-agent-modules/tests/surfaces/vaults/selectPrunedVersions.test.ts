import { DEFAULT_VAULT_RETENTION, type VaultRetention } from "@slopus/happy-agent-client";
import { describe, expect, it } from "vitest";

import { selectPrunedVersions } from "../../../sources/surfaces/vaults/selectPrunedVersions.js";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 10, 5, 12);
const version = (number: number, ageDays: number, pinned = false) => ({
    number,
    createdAt: now - ageDays * DAY,
    pinned,
});
const policy = (fields: Partial<VaultRetention>): VaultRetention => ({
    maxVersions: null,
    maxAgeDays: null,
    keepAllDays: 0,
    thinning: [],
    trashDays: 30,
    ...fields,
});

describe("vault retention", () => {
    it("keeps everything when nothing limits it", () => {
        const versions = [version(1, 400), version(2, 100), version(3, 0)];
        expect(selectPrunedVersions(policy({}), versions, now)).toEqual([]);
    });

    it("keeps the newest versions under a count cap, the newest always included", () => {
        const versions = Array.from({ length: 12 }, (_, index) => version(index + 1, 12 - index));
        expect(selectPrunedVersions(policy({ maxVersions: 10 }), versions, now)).toEqual([1, 2]);
        expect(selectPrunedVersions(policy({ maxVersions: 1 }), versions, now)).toHaveLength(11);
    });

    it("never prunes pinned versions and does not count them", () => {
        const versions = [version(1, 30, true), version(2, 20), version(3, 10), version(4, 0)];
        expect(selectPrunedVersions(policy({ maxVersions: 2 }), versions, now)).toEqual([2]);
        expect(selectPrunedVersions(policy({ maxAgeDays: 5 }), versions, now)).toEqual([2, 3]);
    });

    it("drops by age before anything keeps", () => {
        const versions = [version(1, 40), version(2, 3), version(3, 0)];
        expect(
            selectPrunedVersions(policy({ maxAgeDays: 30, keepAllDays: 365 }), versions, now),
        ).toEqual([1]);
    });

    it("thins to the newest version in each epoch-aligned bucket of a tier", () => {
        // The Time Machine default: every version for a day, daily to 30 days, weekly after.
        const hours = (count: number) => count / 24;
        const versions = [
            version(1, 70),
            version(2, 66),
            version(3, 45),
            version(4, 10 + hours(5)),
            version(5, 10 + hours(1)),
            version(6, 3),
            version(7, hours(3)),
            version(8, hours(1)),
            version(9, 0),
        ];
        const dropped = selectPrunedVersions(DEFAULT_VAULT_RETENTION, versions, now);
        // 7 and 8 are younger than a day; 6 is alone in its day; 4 and 5 share a day.
        expect(dropped).toContain(4);
        expect(dropped).not.toContain(5);
        expect(dropped).not.toContain(6);
        expect(dropped).not.toContain(7);
        expect(dropped).not.toContain(8);
        expect(dropped).not.toContain(3);
        // 70 and 66 days old fall in the same epoch week only when their bucket matches.
        const week = (ageDays: number) => Math.floor((now - ageDays * DAY) / (7 * DAY));
        if (week(70) === week(66)) expect(dropped).toContain(1);
        else expect(dropped).not.toContain(1);
        // Applying the same policy again at the same moment drops nothing more.
        const survivors = versions.filter((candidate) => !dropped.includes(candidate.number));
        expect(selectPrunedVersions(DEFAULT_VAULT_RETENTION, survivors, now)).toEqual([]);
    });

    it("keeps a version older than keepAllDays but younger than every tier", () => {
        const versions = [version(1, 5), version(2, 4), version(3, 0)];
        expect(
            selectPrunedVersions(
                policy({ keepAllDays: 1, thinning: [{ afterDays: 30, everyDays: 7 }] }),
                versions,
                now,
            ),
        ).toEqual([]);
    });
});
