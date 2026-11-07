import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { nextHappyAgentVersion } from "./nextHappyAgentVersion.js";

const scriptPath = fileURLToPath(new URL("./nextHappyAgentVersion.ts", import.meta.url));
const november = new Date("2026-11-07T12:00:00Z");
const legacy = ["v0.4.114", "v0.4.115-preview.1", "happy-agent-client-v0.0.105"];

test("the first release of a month is its first stable or first preview", () => {
    assert.equal(nextHappyAgentVersion(legacy, "stable", november), "2026.11.1");
    assert.equal(nextHappyAgentVersion(legacy, "preview", november), "2026.11.1-preview.1");
    assert.equal(nextHappyAgentVersion([], "preview", november), "2026.11.1-preview.1");
});

test("previews count toward the next stable, and only a stable release moves it", () => {
    const tags = [...legacy, "v2026.11.1-preview.1", "v2026.11.1-preview.2"];
    assert.equal(nextHappyAgentVersion(tags, "preview", november), "2026.11.1-preview.3");
    assert.equal(nextHappyAgentVersion(tags, "stable", november), "2026.11.1");

    tags.push("v2026.11.1");
    assert.equal(nextHappyAgentVersion(tags, "preview", november), "2026.11.2-preview.1");
    assert.equal(nextHappyAgentVersion(tags, "stable", november), "2026.11.2");
});

test("a stable release need not follow a preview, and numbers compare numerically", () => {
    const tags = ["v2026.11.9", "v2026.11.10", "v2026.11.11-preview.9", "v2026.11.11-preview.10"];
    assert.equal(nextHappyAgentVersion(tags, "stable", november), "2026.11.11");
    assert.equal(nextHappyAgentVersion(tags, "preview", november), "2026.11.11-preview.11");
});

test("a new UTC month starts over even when last month's stable never shipped", () => {
    const tags = ["v2026.11.1", "v2026.11.2-preview.4"];
    const december = new Date("2026-12-01T00:00:00Z");
    assert.equal(nextHappyAgentVersion(tags, "preview", december), "2026.12.1-preview.1");
    assert.equal(nextHappyAgentVersion(tags, "stable", december), "2026.12.1");
    // Still November in UTC, whatever the local clock says.
    const lastNovemberSecond = new Date("2026-11-30T23:59:59Z");
    assert.equal(nextHappyAgentVersion(tags, "stable", lastNovemberSecond), "2026.11.2");
    assert.equal(
        nextHappyAgentVersion(tags, "stable", new Date("2027-01-15T00:00:00Z")),
        "2027.1.1",
    );
});

test("tags that are not Agent release identities never count", () => {
    const tags = [
        "v2026.11.5-beta.1",
        "v2026.11.05",
        "v2026.011.5",
        "2026.11.5",
        "v2026.11.5+build",
        "v2026.11.1-preview.01",
        "happy-agent-client-v2026.11.5",
    ];
    assert.equal(nextHappyAgentVersion(tags, "stable", november), "2026.11.1");
    assert.equal(nextHappyAgentVersion(tags, "preview", november), "2026.11.1-preview.1");
});

test("the command reads the repository's tags and requires a channel", async () => {
    const directory = await mkdtemp(join(tmpdir(), "next-agent-version-"));
    const git = (...args: string[]) => {
        const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
    };
    const run = (...args: string[]) =>
        spawnSync(process.execPath, [scriptPath, ...args], { cwd: directory, encoding: "utf8" });
    try {
        git("init", "--quiet");
        git(
            "-c",
            "user.name=Release test",
            "-c",
            "user.email=release@example.test",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "Initial commit",
        );
        const now = new Date();
        const month = `${now.getUTCFullYear()}.${now.getUTCMonth() + 1}`;
        for (const tag of ["v0.4.114", `v${month}.1`, `v${month}.2-preview.3`]) git("tag", tag);

        const preview = run("preview");
        assert.equal(preview.status, 0, preview.stderr);
        assert.equal(preview.stdout, `${month}.2-preview.4\n`);
        const stable = run("stable");
        assert.equal(stable.status, 0, stable.stderr);
        assert.equal(stable.stdout, `${month}.2\n`);
        assert.notEqual(run().status, 0);
        assert.notEqual(run("production").status, 0);
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});
