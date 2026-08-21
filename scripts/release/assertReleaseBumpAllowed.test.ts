import assert from "node:assert/strict";
import { test } from "node:test";

import { assertReleaseBumpAllowed } from "./assertReleaseBumpAllowed.js";

test("a feature release is an ordinary minor bump", () => {
    assert.doesNotThrow(() =>
        assertReleaseBumpAllowed({ currentVersion: "0.0.147", requested: "minor" }),
    );
});

test("a fix release stays a patch", () => {
    assert.doesNotThrow(() =>
        assertReleaseBumpAllowed({ currentVersion: "0.1.0", requested: "patch" }),
    );
});

test("an explicit version inside 0.x is fine", () => {
    assert.doesNotThrow(() =>
        assertReleaseBumpAllowed({ currentVersion: "0.0.147", requested: "0.1.0" }),
    );
});

test("refuses a major bump while Happy Terminal is still 0.x", () => {
    assert.throws(
        () => assertReleaseBumpAllowed({ currentVersion: "0.0.147", requested: "major" }),
        /not available.*Use 'minor' for new features/su,
    );
});

test("refuses reaching 1.0.0 by naming it outright", () => {
    assert.throws(
        () => assertReleaseBumpAllowed({ currentVersion: "0.0.147", requested: "1.0.0" }),
        /does not release 1\.0\.0 yet/u,
    );
});

test("refuses a premajor prerelease too", () => {
    assert.throws(
        () => assertReleaseBumpAllowed({ currentVersion: "0.1.0", requested: "premajor" }),
        /not available/u,
    );
});

// Reaching 1.0.0 is the point of the rule, not a permanent ban: once Happy Terminal is there, releasing
// 2.0.0 is an ordinary decision again and this stops having an opinion.
test("stops applying once Happy Terminal has left 0.x", () => {
    assert.doesNotThrow(() =>
        assertReleaseBumpAllowed({ currentVersion: "1.4.2", requested: "major" }),
    );
    assert.doesNotThrow(() =>
        assertReleaseBumpAllowed({ currentVersion: "1.4.2", requested: "2.0.0" }),
    );
});
