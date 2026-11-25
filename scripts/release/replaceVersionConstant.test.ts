import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { replaceVersionConstant } from "./replaceVersionConstant.js";
import { resolveReleasePackage } from "./resolveReleasePackage.js";

test("sets the version constant and leaves the rest of the file alone", () => {
    const source = '/** Doc "0.0.1". */\nexport const HAPPY_PROVIDERS_VERSION = "0.0.67";\n';
    assert.equal(
        replaceVersionConstant(source, "0.0.68"),
        '/** Doc "0.0.1". */\nexport const HAPPY_PROVIDERS_VERSION = "0.0.68";\n',
    );
    // A constant already at the release version, as after a hand bump, stays as it is.
    assert.equal(replaceVersionConstant(source, "0.0.67"), source);
});

test("finds the constant in happy-providers' own version file", () => {
    const path = resolveReleasePackage("happy-providers").versionConstantPath!;
    const source = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    assert.match(replaceVersionConstant(source, "9.9.9"), /_VERSION = "9\.9\.9";/u);
    assert.throws(() => replaceVersionConstant("const x = 1;", "1.0.0"), /version constant/u);
});
