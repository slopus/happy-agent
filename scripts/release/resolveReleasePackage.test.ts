import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveReleasePackage } from "./resolveReleasePackage.js";

describe("resolveReleasePackage", () => {
    it("requires an explicit release target", () => {
        assert.throws(() => resolveReleasePackage(undefined), /Unknown release package/u);
    });

    it("validates only happy-agent-base for its local and remote releases", () => {
        const target = resolveReleasePackage("happy-agent-base");

        assert.equal(target.key, "happy-agent-base");
        assert.equal(target.tagPrefix, "happy-agent-base-v");
        assert.match(target.directory, /packages\/happy-agent-base\/?$/u);
        assert.deepEqual(target.buildArguments, ["--filter", "@slopus/happy-agent-base", "build"]);
        assert.deepEqual(target.checkArguments, ["--filter", "@slopus/happy-agent-base", "check"]);
        assert.deepEqual(target.testArguments, [["--filter", "@slopus/happy-agent-base", "test"]]);
    });

    it("gives happy-agent-client its own tag namespace and package directory", () => {
        const target = resolveReleasePackage("happy-agent-client");

        assert.equal(target.key, "happy-agent-client");
        assert.equal(target.tagPrefix, "happy-agent-client-v");
        assert.match(target.directory, /packages\/happy-agent-client\/?$/u);
        assert.deepEqual(target.buildArguments, [
            "--filter",
            "@slopus/happy-agent-client",
            "build",
        ]);
        assert.deepEqual(target.checkArguments, [
            "--filter",
            "@slopus/happy-agent-client",
            "check",
        ]);
        assert.deepEqual(target.testArguments, [
            ["--filter", "@slopus/happy-agent-client", "test"],
        ]);
    });

    it("gives happy-plugins its own tag namespace and package directory", () => {
        const target = resolveReleasePackage("happy-plugins");

        assert.equal(target.key, "happy-plugins");
        assert.equal(target.tagPrefix, "happy-plugins-v");
        assert.match(target.directory, /packages\/happy-plugins\/?$/u);
        assert.deepEqual(target.buildArguments, ["--filter", "happy-plugins", "build"]);
    });

    it("gives happy-providers its own tag namespace and package directory", () => {
        const target = resolveReleasePackage("happy-providers");

        assert.equal(target.key, "happy-providers");
        assert.equal(target.tagPrefix, "happy-providers-v");
        assert.match(target.directory, /packages\/happy-providers\/?$/u);
        assert.deepEqual(target.buildArguments, ["--filter", "@slopus/happy-providers", "build"]);
        assert.deepEqual(target.checkArguments, ["--filter", "@slopus/happy-providers", "check"]);
        assert.deepEqual(target.testArguments, [
            ["run", "test:scripts"],
            ["--filter", "@slopus/happy-providers", "test"],
        ]);
    });

    it("rejects a target that could publish an unintended workspace package", () => {
        assert.throws(() => resolveReleasePackage("other"), /Unknown release package other/u);
    });
});
