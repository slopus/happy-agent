import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertBundledHappyRuntimeDependencies } from "./assertBundledHappyRuntimeDependencies.js";

describe("assertBundledHappyRuntimeDependencies", () => {
    it("accepts the Happy Agent client as Rig's only agent dependency", () => {
        assert.doesNotThrow(() =>
            assertBundledHappyRuntimeDependencies({
                dependencies: { "@slopus/happy-agent-client": "0.0.12" },
                name: "@slopus/rig",
                version: "1.2.3",
            }),
        );
    });

    it("rejects daemon implementation packages in either dependency section", () => {
        assert.throws(
            () =>
                assertBundledHappyRuntimeDependencies({
                    dependencies: { "@slopus/happy-agent-client": "0.0.12" },
                    devDependencies: { "@slopus/happy-agent-modules": "workspace:*" },
                    name: "@slopus/rig",
                    version: "1.2.3",
                }),
            /must not depend on Happy Agent implementation packages/u,
        );
    });

    it("rejects a missing public client dependency", () => {
        assert.throws(
            () =>
                assertBundledHappyRuntimeDependencies({
                    name: "@slopus/rig",
                    version: "1.2.3",
                }),
            /must depend on @slopus\/happy-agent-client/u,
        );
    });
});
