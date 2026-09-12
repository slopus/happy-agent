import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const workflowUrl = new URL("../../.github/workflows/release-happy-agent.yml", import.meta.url);

async function workflowStep(name: string): Promise<string> {
    const workflow = await readFile(workflowUrl, "utf8");
    const start = workflow.indexOf(`- name: ${name}\n`);
    assert.notEqual(start, -1, `Missing workflow step: ${name}`);
    const script = workflow
        .slice(start)
        .match(/ {14}run: \|\n([\s\S]*?)(?=\n {12}- name:|$)/u)?.[1];
    assert.notEqual(script, undefined, `Missing Bash script: ${name}`);
    return script!
        .split("\n")
        .map((line) => line.slice(18))
        .join("\n");
}

test("Agent workflow accepts stable and numbered preview versions only with matching release flags", async () => {
    const script = await workflowStep("Validate release inputs");
    const stubs = `
git() {
    if [[ "$1" == fetch ]]; then return 0; fi
    if [[ "$2" == --verify ]]; then return 1; fi
    printf 'same-main-commit\\n'
}
gh() { return 1; }
`;
    for (const [version, prerelease, accepted] of [
        ["0.4.67", "false", true],
        ["1.2.3", "false", true],
        ["0.4.67-preview.0", "true", true],
        ["0.4.67-preview.1", "true", true],
        ["0.4.67-preview.12", "true", true],
        ["0.4.67", "true", false],
        ["0.4.67-preview.1", "false", false],
        ["0.4.67-beta.1", "true", false],
        ["0.4.67-canary.1.abcdef0", "true", false],
        ["0.4.67-preview", "true", false],
        ["0.4.67-preview.01", "true", false],
        ["0.4.67+metadata", "false", false],
        ["00.4.67", "false", false],
        ["v0.4.67", "false", false],
        ["0.4.67", "not-a-boolean", false],
    ] as const) {
        const result = spawnSync("bash", ["-e", "-c", `${stubs}\n${script}`], {
            encoding: "utf8",
            env: {
                ...process.env,
                GITHUB_REF: "refs/heads/main",
                RELEASE_VERSION: version,
                RELEASE_TAG: `v${version}`,
                RELEASE_PRERELEASE: prerelease,
                RELEASE_NOTES: "Release notes.",
            },
        });
        assert.equal(
            result.status,
            accepted ? 0 : 1,
            `${version}, prerelease=${prerelease}: ${result.stderr}`,
        );
    }
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
                        RELEASE_VERSION: preview ? "0.4.67-preview.1" : "0.4.67",
                        RELEASE_TAG: preview ? "v0.4.67-preview.1" : "v0.4.67",
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
    assert.doesNotMatch(workflow, /\|\| 'happy-terminal'/);
    assert.doesNotMatch(workflow, /if: startsWith\(github.ref, 'refs\/tags\/'\)/);
    assert.match(workflow, /run: pnpm exec tsx scripts\/publishPackage\.ts/);
});
