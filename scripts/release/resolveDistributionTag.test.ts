import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveDistributionTag } from "./resolveDistributionTag.js";

test("a release claims latest", () => {
    assert.equal(resolveDistributionTag({ requestedTag: undefined, version: "0.0.148" }), "latest");
});

test("an empty channel still means latest", () => {
    assert.equal(resolveDistributionTag({ requestedTag: "", version: "0.0.148" }), "latest");
});

test("a canary build claims its own channel", () => {
    assert.equal(
        resolveDistributionTag({ requestedTag: "canary", version: "0.0.0-canary.403.c669089" }),
        "canary",
    );
});

test("a prerelease may claim a channel of its own", () => {
    assert.equal(
        resolveDistributionTag({ requestedTag: "preview", version: "0.0.148-preview.0" }),
        "preview",
    );
});

test("refuses to hand a prerelease to every user", () => {
    assert.throws(
        () => resolveDistributionTag({ requestedTag: undefined, version: "0.0.148-preview.0" }),
        /must not be published as 'latest'/,
    );
});

test("refuses a canary version asked for latest outright", () => {
    assert.throws(
        () =>
            resolveDistributionTag({
                requestedTag: "latest",
                version: "0.0.0-canary.403.c669089",
            }),
        /must not be published as 'latest'/,
    );
});
