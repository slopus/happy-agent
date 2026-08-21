import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertReleaseTagMatchesPackageVersion } from "./assertReleaseTagMatchesPackageVersion.js";

const MANIFEST = {
    name: "@slopus/happy-terminal",
    version: "1.2.3",
};

describe("assertReleaseTagMatchesPackageVersion", () => {
    it("accepts the package version with a v prefix", () => {
        assert.doesNotThrow(() => assertReleaseTagMatchesPackageVersion("v1.2.3", MANIFEST));
    });

    it("rejects a tag for a different package version", () => {
        assert.throws(
            () => assertReleaseTagMatchesPackageVersion("v1.2.4", MANIFEST),
            /Expected v1\.2\.3/u,
        );
    });

    it("supports a package-specific tag namespace", () => {
        assert.doesNotThrow(() =>
            assertReleaseTagMatchesPackageVersion(
                "happy-providers-v1.2.3",
                { ...MANIFEST, name: "@slopus/happy-providers" },
                "happy-providers-v",
            ),
        );
        assert.throws(
            () =>
                assertReleaseTagMatchesPackageVersion(
                    "v1.2.3",
                    { ...MANIFEST, name: "@slopus/happy-providers" },
                    "happy-providers-v",
                ),
            /Expected happy-providers-v1\.2\.3/u,
        );
    });
});
