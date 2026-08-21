import assert from "node:assert/strict";
import { test } from "node:test";

import { replacePackageVersion } from "./replacePackageVersion.js";

test("replaces a package version while preserving the manifest layout", () => {
    assert.equal(
        replacePackageVersion(
            '{\n    "name": "@slopus/happy-terminal",\n    "version": "0.3.0-beta.13"\n}\n',
            "0.3.0-beta.14",
        ),
        '{\n    "name": "@slopus/happy-terminal",\n    "version": "0.3.0-beta.14"\n}\n',
    );
});

test("accepts stable semantic versions", () => {
    assert.equal(
        replacePackageVersion('{"version":"0.3.0-beta.14"}', "0.3.0"),
        '{"version": "0.3.0"}',
    );
});

test("leaves an already-versioned manifest unchanged", () => {
    const manifest = '{"version": "0.3.0-beta.14"}';
    assert.equal(replacePackageVersion(manifest, "0.3.0-beta.14"), manifest);
});

test("rejects non-semantic versions", () => {
    assert.throws(() => replacePackageVersion('{"version": "0.3.0"}', "next"), /is not semantic/u);
});

test("rejects a manifest without a replaceable version", () => {
    assert.throws(
        () => replacePackageVersion('{"name": "@slopus/happy-terminal"}', "0.3.0"),
        /Could not replace/u,
    );
});
