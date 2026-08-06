import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertHappyRuntimeDependencies } from "./assertHappyRuntimeDependencies.js";

const dependencies = {
    "@noble/ciphers": "1.0.0",
    "@noble/curves": "1.0.0",
    "@vscode/ripgrep": "1.0.0",
    qrcode: "1.0.0",
    "qrcode-terminal": "1.0.0",
    "socket.io-client": "1.0.0",
};

describe("assertHappyRuntimeDependencies", () => {
    it("accepts a package with every Happy runtime dependency", () => {
        assert.doesNotThrow(() =>
            assertHappyRuntimeDependencies({
                dependencies,
                name: "@slopus/rig",
                version: "1.2.3",
            }),
        );
    });

    it("accepts Happy dependencies compiled into the published bundle", () => {
        assert.doesNotThrow(() =>
            assertHappyRuntimeDependencies({
                devDependencies: dependencies,
                name: "@slopus/rig",
                version: "1.2.3",
            }),
        );
    });

    it("rejects a release that would omit Happy encryption or transport dependencies", () => {
        assert.throws(
            () =>
                assertHappyRuntimeDependencies({
                    dependencies: { ...dependencies, "@noble/ciphers": undefined as never },
                    name: "@slopus/rig",
                    version: "1.2.3",
                }),
            /@noble\/ciphers/u,
        );
    });
});
