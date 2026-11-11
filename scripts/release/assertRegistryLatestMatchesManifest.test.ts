import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertRegistryLatestMatchesManifest } from "./assertRegistryLatestMatchesManifest.js";

const MANIFEST = { name: "@slopus/happy-providers", version: "0.0.5" };

describe("assertRegistryLatestMatchesManifest", () => {
    it("accepts a worktree aligned with npm latest", () => {
        assert.doesNotThrow(() => assertRegistryLatestMatchesManifest(MANIFEST, '"0.0.5"'));
    });

    it("accepts pnpm's single-result array for npm latest", () => {
        assert.doesNotThrow(() => assertRegistryLatestMatchesManifest(MANIFEST, '["0.0.5"]'));
    });

    it("preserves drift detection and recovery for pnpm's array result", () => {
        assert.throws(
            () => assertRegistryLatestMatchesManifest(MANIFEST, '["0.0.6"]'),
            /worktree but npm latest is 0\.0\.6/u,
        );
        assert.doesNotThrow(() =>
            assertRegistryLatestMatchesManifest(MANIFEST, '["0.0.3"]', {
                isTaggedUnpublishedVersion: (version) => version === "0.0.4" || version === "0.0.5",
            }),
        );
    });

    it("rejects empty, multiple, or malformed registry results", () => {
        for (const latest of ["[]", '["0.0.5", "0.0.6"]', "[5]", "null", "{}"]) {
            assert.throws(() => assertRegistryLatestMatchesManifest(MANIFEST, latest));
        }
    });

    it("rejects version drift before another release can hide it", () => {
        assert.throws(
            () => assertRegistryLatestMatchesManifest(MANIFEST, '"0.0.6"'),
            /worktree but npm latest is 0\.0\.6/u,
        );
    });

    it("accepts consecutive unpublished patches when every failed release tag was verified", () => {
        assert.doesNotThrow(() =>
            assertRegistryLatestMatchesManifest(MANIFEST, '"0.0.3"', {
                isTaggedUnpublishedVersion: (version) => version === "0.0.4" || version === "0.0.5",
            }),
        );
    });

    it("rejects a gap in the unpublished release tag chain", () => {
        assert.throws(
            () =>
                assertRegistryLatestMatchesManifest(MANIFEST, '"0.0.2"', {
                    isTaggedUnpublishedVersion: (version) => version !== "0.0.4",
                }),
            /worktree but npm latest/u,
        );
    });

    it("rejects forward, cross-minor, prerelease, or excessive drift during recovery", () => {
        for (const latest of ["0.0.6", "0.1.4", "0.0.4-beta.1", "0.0.101"]) {
            assert.throws(
                () =>
                    assertRegistryLatestMatchesManifest(MANIFEST, JSON.stringify(latest), {
                        isTaggedUnpublishedVersion: () => true,
                    }),
                /worktree but npm latest/u,
            );
        }
    });
});
