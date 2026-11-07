import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const workflowUrl = new URL("../../.github/workflows/release-happy-agent.yml", import.meta.url);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

async function workflowStep(name: string): Promise<string> {
    const workflow = await readFile(workflowUrl, "utf8");
    const start = workflow.indexOf(`- name: ${name}\n`);
    assert.notEqual(start, -1, `Missing workflow step: ${name}`);
    const script = workflow.slice(start).match(/ {14}run: \|\n((?: {18}[^\n]*(?:\n|$)|\n)*)/u)?.[1];
    assert.notEqual(script, undefined, `Missing Bash script: ${name}`);
    return script!
        .split("\n")
        .map((line) => line.slice(18))
        .join("\n");
}

test("Agent workflow computes the next CalVer version and accepts only that one with matching release flags", async () => {
    const script = await workflowStep("Validate release inputs");
    const directory = await mkdtemp(join(tmpdir(), "agent-release-inputs-"));
    // The version script runs Git as a child process, so it sees this executable, not the stubs.
    await writeFile(join(directory, "git"), '#!/bin/sh\nprintf "%s\\n" $FAKE_TAGS\n', {
        mode: 0o755,
    });
    const stubs = `
git() {
    if [[ "$1" == fetch ]]; then return 0; fi
    if [[ "$2" == --verify ]]; then return 1; fi
    printf 'same-main-commit\\n'
}
gh() { return 1; }
`;
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = `${year}.${now.getUTCMonth() + 1}`;
    const legacy = "v0.4.114 v0.4.115-preview.1 happy-agent-client-v0.0.105";
    const previewed = `${legacy} v${month}.1-preview.1 v${month}.1-preview.2`;
    const shipped = `${previewed} v${month}.1`;
    try {
        for (const [requested, prerelease, tags, released] of [
            ["", "true", legacy, `${month}.1-preview.1`],
            ["", "false", legacy, `${month}.1`],
            [`${month}.1-preview.1`, "true", legacy, `${month}.1-preview.1`],
            [`${month}.1`, "false", legacy, `${month}.1`],
            ["", "true", previewed, `${month}.1-preview.3`],
            ["", "false", previewed, `${month}.1`],
            ["", "true", shipped, `${month}.2-preview.1`],
            [`${month}.2`, "false", shipped, `${month}.2`],
            [`${month}.1-preview.2`, "true", previewed, undefined],
            [`${month}.2-preview.1`, "true", previewed, undefined],
            [`${month}.1`, "false", shipped, undefined],
            ["0.4.116", "false", legacy, undefined],
            ["0.4.116-preview.1", "true", legacy, undefined],
            [`${month}.1`, "true", legacy, undefined],
            [`${month}.1-preview.1`, "false", legacy, undefined],
            [`${month}.1-beta.1`, "true", legacy, undefined],
            [`${month}.1-canary.1.abcdef0`, "true", legacy, undefined],
            [`${month}.1-preview`, "true", legacy, undefined],
            [`${month}.1-preview.01`, "true", legacy, undefined],
            [`${month}.1+metadata`, "false", legacy, undefined],
            [`${year}.0${now.getUTCMonth() + 1}.1`, "false", legacy, undefined],
            [`v${month}.1`, "false", legacy, undefined],
            ["", "not-a-boolean", legacy, undefined],
            [`${month}.1`, "not-a-boolean", legacy, undefined],
        ] as const) {
            const githubOutput = join(directory, "output");
            const githubEnvironment = join(directory, "environment");
            await writeFile(githubOutput, "");
            await writeFile(githubEnvironment, "");
            const result = spawnSync("bash", ["-e", "-c", `${stubs}\n${script}`], {
                cwd: repositoryRoot,
                encoding: "utf8",
                env: {
                    ...process.env,
                    PATH: `${directory}:${process.env.PATH}`,
                    FAKE_TAGS: tags,
                    GITHUB_ENV: githubEnvironment,
                    GITHUB_OUTPUT: githubOutput,
                    GITHUB_REF: "refs/heads/main",
                    GITHUB_STEP_SUMMARY: join(directory, "summary"),
                    REQUESTED_VERSION: requested,
                    RELEASE_PRERELEASE: prerelease,
                    RELEASE_NOTES: "Release notes.",
                },
            });
            const label = `${requested || "(computed)"}, prerelease=${prerelease}, tags=${tags}`;
            assert.equal(
                result.status,
                released === undefined ? 1 : 0,
                `${label}: ${result.stderr}`,
            );
            if (released !== undefined) {
                assert.equal(await readFile(githubOutput, "utf8"), `version=${released}\n`, label);
                assert.equal(
                    await readFile(githubEnvironment, "utf8"),
                    `RELEASE_TAG=v${released}\n`,
                    label,
                );
            }
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("only release-input validation reads the requested version; every job releases the validated one", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    const jobs = workflow.slice(workflow.indexOf("\njobs:\n"));
    assert.deepEqual(
        [...jobs.matchAll(/^.*inputs\.version.*$/gmu)].map((match) => match[0].trim()),
        ["REQUESTED_VERSION: ${{ inputs.version }}"],
    );
    assert.doesNotMatch(
        workflow.slice(0, workflow.indexOf("\njobs:\n")),
        /RELEASE_(?:TAG|VERSION):/u,
    );
    assert.match(jobs, /outputs:\n {12}version: \$\{\{ steps\.release\.outputs\.version \}\}/u);
    assert.match(jobs, /with:\n {12}version: \$\{\{ needs\.validate\.outputs\.version \}\}/u);
    assert.match(
        jobs,
        /HAPPY_AGENT_RELEASE_VERSION: \$\{\{ needs\.validate\.outputs\.version \}\}/u,
    );
    const publish = jobs.slice(jobs.indexOf("\n    publish:\n"));
    assert.match(publish, /needs:\n {12}- validate\n/u);
    assert.match(publish, /RELEASE_TAG: v\$\{\{ needs\.validate\.outputs\.version \}\}/u);
});

test("Agent preview creation and publication explicitly stay off latest; stable publication keeps latest", async () => {
    const script = await workflowStep("Publish the tag and GitHub Release");
    const directory = await mkdtemp(join(tmpdir(), "agent-preview-workflow-"));
    try {
        for (const preview of [true, false]) {
            const callsPath = join(directory, `${preview}.calls`);
            const result = spawnSync(
                "bash",
                [
                    "-e",
                    "-c",
                    `
gh() {
    printf '%s\\n' "$*" >> "$GH_CALLS"
    if [[ "$1 $2" == 'release view' ]]; then printf 'https://example.test/release\\n'; fi
}
${script}`,
                ],
                {
                    cwd: directory,
                    encoding: "utf8",
                    env: {
                        ...process.env,
                        GH_CALLS: callsPath,
                        GITHUB_SHA: "verified-commit",
                        GITHUB_STEP_SUMMARY: join(directory, "summary"),
                        RELEASE_VERSION: preview ? "2026.11.1-preview.1" : "2026.11.1",
                        RELEASE_TAG: preview ? "v2026.11.1-preview.1" : "v2026.11.1",
                        RELEASE_PRERELEASE: String(preview),
                        RELEASE_NOTES: "The actual notes, not a path.",
                    },
                },
            );
            assert.equal(result.status, 0, result.stderr);
            const calls = (await readFile(callsPath, "utf8")).split("\n");
            const create = calls.find((line) => line.startsWith("release create "))!;
            const edit = calls.find((line) => line.startsWith("release edit "))!;
            assert.match(create, /--target verified-commit/);
            assert.match(edit, /--draft=false/);
            if (preview) {
                assert.match(create, /--prerelease/);
                assert.match(create, /--latest=false/);
                assert.match(edit, /--latest=false/);
                assert.doesNotMatch(`${create} ${edit}`, /--latest(?: |$)/);
            } else {
                assert.doesNotMatch(create, /--prerelease/);
                assert.match(edit, /--latest(?: |$)/);
            }
            assert.equal(
                await readFile(join(directory, ".release/notes.md"), "utf8"),
                "The actual notes, not a path.\n",
            );
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("npm publishing retains library tag triggers but has no on-main canary trigger or job", async () => {
    const workflow = await readFile(
        new URL("../../.github/workflows/publish.yml", import.meta.url),
        "utf8",
    );
    const triggers = workflow.slice(0, workflow.indexOf("\nenv:"));
    assert.doesNotMatch(triggers, /branches:/);
    for (const tag of ["happy-agent-base-v*", "happy-plugins-v*", "happy-providers-v*"]) {
        assert.ok(triggers.includes(`"${tag}"`));
    }
    assert.doesNotMatch(workflow, /\n    canary:|detectCanaryPackageChanges|setCanaryVersion/);
    assert.doesNotMatch(workflow, /if: startsWith\(github.ref, 'refs\/tags\/'\)/);
    assert.match(workflow, /run: pnpm exec tsx scripts\/publishPackage\.ts/);
});
