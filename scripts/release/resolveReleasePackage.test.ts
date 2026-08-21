import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { resolveReleasePackage } from "./resolveReleasePackage.js";

describe("resolveReleasePackage", () => {
    it("keeps Happy Terminal as the default release target", () => {
        const target = resolveReleasePackage(undefined);

        assert.equal(target.key, "happy-terminal");
        assert.equal(target.tagPrefix, "happy-terminal-v");
        assert.deepEqual(target.testArguments, [["run", "test:release"]]);
        const rootManifest = JSON.parse(
            readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
        ) as { scripts: Record<string, string> };
        assert.match(
            rootManifest.scripts["test:release"] ?? "",
            /--filter '!@slopus\/happy-providers'/u,
        );
        assert.match(rootManifest.scripts["test:release"] ?? "", /--filter '!happy-plugins'/u);
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
