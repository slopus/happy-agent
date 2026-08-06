import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveCanaryVersion } from "./resolveCanaryVersion.js";

test("follows the release it was built from", () => {
    assert.equal(
        resolveCanaryVersion({
            baseVersion: "0.0.147",
            buildNumber: "41",
            commit: "0123456789abcdef",
        }),
        "0.0.148-canary.41.0123456",
    );
});

test("follows a feature release the same way", () => {
    assert.equal(
        resolveCanaryVersion({ baseVersion: "0.1.0", buildNumber: "7", commit: "abcdef1234567" }),
        "0.1.1-canary.7.abcdef1",
    );
});

test("shortens and normalizes the commit", () => {
    assert.equal(
        resolveCanaryVersion({ baseVersion: "0.0.9", buildNumber: "7", commit: "ABCDEF1234567" }),
        "0.0.10-canary.7.abcdef1",
    );
});

/**
 * The shape is what places the build: semver puts a prerelease below the release it prefixes, so
 * numbering a canary as a prerelease of the *next* patch puts it above the release it was built
 * from and below everything after. Both halves have to hold — a canary numbered as a prerelease of
 * the current version would sort below the release it already contains.
 */
test("is a prerelease of the release after the one it followed", () => {
    const canary = resolveCanaryVersion({
        baseVersion: "0.0.147",
        buildNumber: "41",
        commit: "0123456789abcdef",
    });
    const [release, prerelease] = canary.split("-");
    assert.equal(release, "0.0.148");
    assert.ok(prerelease !== undefined, "a canary must be a prerelease, or a range could reach it");
});

test("rejects a build number that is not a number", () => {
    assert.throws(
        () =>
            resolveCanaryVersion({
                baseVersion: "0.0.147",
                buildNumber: "nightly",
                commit: "0123456789abcdef",
            }),
        /not a canary build number/,
    );
});

test("rejects a commit that is too short", () => {
    assert.throws(
        () => resolveCanaryVersion({ baseVersion: "0.0.147", buildNumber: "1", commit: "abc" }),
        /not a commit/,
    );
});

test("rejects a base that is not a release version", () => {
    assert.throws(
        () =>
            resolveCanaryVersion({
                baseVersion: "nightly",
                buildNumber: "1",
                commit: "0123456789abcdef",
            }),
        /not a version a canary build can follow/,
    );
});
