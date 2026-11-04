import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { releaseNotesPath, validateReleaseNotes } from "./validateReleaseNotes.js";

const scriptPath = fileURLToPath(new URL("./validateReleaseNotes.ts", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

test("accepts features and fixes as short plain bullets", () => {
    assert.deepEqual(
        validateReleaseNotes(
            [
                "## Features",
                "- Sidebar sorts work by topic",
                "- New work appears instantly",
                "",
                "## Fixes",
                "- Reliable task and bot names",
                "",
            ].join("\n"),
        ),
        [],
    );
});

test("accepts a missing or empty section and an empty file", () => {
    assert.deepEqual(validateReleaseNotes("## Fixes\n- Reliable task and bot names\n"), []);
    assert.deepEqual(validateReleaseNotes("## Features\n\n## Fixes\n- Steadier runs\n"), []);
    assert.deepEqual(validateReleaseNotes(""), []);
    assert.deepEqual(validateReleaseNotes("## Features\r\n- New work appears instantly\r\n"), []);
});

test("rejects anything but the two sections and their bullets", () => {
    for (const [markdown, problem] of [
        ["## Changes\n- Something new\n", /only "## Features", "## Fixes", and "## Thanks"/u],
        ["# Features\n- Something new\n", /expected a "## Features" or "## Fixes" heading/u],
        ["## Features\nSomething new\n", /expected a "## Features" or "## Fixes" heading/u],
        ["## Features\n* Something new\n", /expected a "## Features" or "## Fixes" heading/u],
        ["## Features\n- Parent\n  - Nested\n", /expected a "## Features" or "## Fixes" heading/u],
        ["- Something new\n", /must sit under/u],
        ["## Fixes\n- One\n## Fixes\n- Two\n", /appears more than once/u],
        ["## Fixes\n- \n", /the bullet is empty/u],
    ] as const) {
        const problems = validateReleaseNotes(markdown);
        assert.ok(
            problems.some((message) => problem.test(message)),
            `${JSON.stringify(markdown)}: ${problems.join(" ")}`,
        );
    }
});

test("keeps each bullet to six plain words and each section to three bullets", () => {
    assert.deepEqual(validateReleaseNotes("## Features\n- One two three four five six\n"), []);
    assert.match(
        validateReleaseNotes("## Features\n- One two three four five six seven\n").join(""),
        /has 7 words; keep it to 6/u,
    );
    for (const bullet of [
        "**Bold** names",
        "Faster `search`",
        "See [docs](x)",
        "<b>New</b> names",
    ]) {
        assert.match(
            validateReleaseNotes(`## Features\n- ${bullet}\n`).join(""),
            /plain text/u,
            bullet,
        );
    }
    assert.deepEqual(validateReleaseNotes("## Fixes\n- One\n- Two\n- Three\n"), []);
    assert.match(
        validateReleaseNotes("## Fixes\n- One\n- Two\n- Three\n- Four\n").join(""),
        /more than 3 bullets/u,
    );
});

test("thanks people by GitHub login and the issues they are credited for", () => {
    assert.deepEqual(
        validateReleaseNotes(
            [
                "## Fixes",
                "- Windows sandbox commands run again",
                "",
                "## Thanks",
                "",
                "- @shellus slopus/happy-agent#73",
                "- @chegoapp1-bit slopus/happy-agent#75",
                "- @acidsatan slopus/happy-agent#74 slopus/happy#1941",
                "",
            ].join("\n"),
        ),
        [],
    );
    for (const bullet of [
        "shellus slopus/happy-agent#73",
        "@shellus",
        "@shellus #73",
        "@shellus other/repo#73",
        "@shellus slopus/happy-agent#73 and more",
        "@-shellus slopus/happy-agent#73",
        "[@shellus](https://github.com/shellus) slopus/happy-agent#73",
    ]) {
        assert.match(
            validateReleaseNotes(`## Thanks\n- ${bullet}\n`).join(""),
            /thank someone as/u,
            bullet,
        );
    }
    assert.match(
        validateReleaseNotes(
            "## Thanks\n- @shellus slopus/happy-agent#73\n- @Shellus slopus/happy-agent#75\n",
        ).join(""),
        /@Shellus is thanked more than once/u,
    );
    const nine = Array.from({ length: 9 }, (_, i) => `- @person${i} slopus/happy#${i + 1}`);
    assert.match(
        validateReleaseNotes(`## Thanks\n${nine.join("\n")}\n`).join(""),
        /more than 8 people/u,
    );
});

test("every committed notes file is named for a release tag and valid", async () => {
    const files = await readdir(join(repositoryRoot, "release-notes"));
    assert.ok(files.length > 0);
    for (const file of files) {
        assert.match(file, /^v\d+\.\d+\.\d+(-preview\.\d+)?\.md$/u);
        const tag = file.slice(0, -".md".length);
        const markdown = await readFile(join(repositoryRoot, releaseNotesPath(tag)), "utf8");
        assert.deepEqual(validateReleaseNotes(markdown), [], file);
    }
});

test("the command checks the released tag's file and fails when it is missing or invalid", async () => {
    const directory = await mkdtemp(join(tmpdir(), "release-notes-"));
    const run = (tag: string) =>
        spawnSync(process.execPath, [scriptPath, tag], { cwd: directory, encoding: "utf8" });
    try {
        await mkdir(join(directory, "release-notes"));
        await writeFile(
            join(directory, "release-notes", "v1.2.3-preview.4.md"),
            "## Features\n- New work appears instantly\n",
        );
        await writeFile(
            join(directory, "release-notes", "v1.2.3.md"),
            "New work appears instantly\n",
        );

        const valid = run("v1.2.3-preview.4");
        assert.equal(valid.status, 0, valid.stderr);
        const invalid = run("v1.2.3");
        assert.equal(invalid.status, 1);
        assert.match(invalid.stderr, /release-notes\/v1\.2\.3\.md is not valid/u);
        const missing = run("v1.2.4");
        assert.equal(missing.status, 1);
        assert.match(missing.stderr, /release-notes\/v1\.2\.4\.md is missing/u);
        assert.notEqual(run("1.2.3").status, 0);
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

test("the Agent workflow validates the release's notes file before building", async () => {
    const workflow = await readFile(
        new URL("../../.github/workflows/release-happy-agent.yml", import.meta.url),
        "utf8",
    );
    const validateJob = workflow.slice(
        workflow.indexOf("    validate:\n"),
        workflow.indexOf("    verify:\n"),
    );
    assert.match(
        validateJob,
        /run: node scripts\/release\/validateReleaseNotes\.ts "\$RELEASE_TAG"/u,
    );
});
