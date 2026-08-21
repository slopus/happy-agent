import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const WORKFLOWS_DIRECTORY = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    ".github",
    "workflows",
);
const HAPPY_AGENT_RELEASE_WORKFLOW = "release-happy-agent.yml";

function occurrences(source: string, pattern: RegExp): number {
    return [...source.matchAll(pattern)].length;
}

describe("GitHub Release latest policy", () => {
    it("lets only Happy Agent releases mark themselves as latest", async () => {
        const workflowNames = (await readdir(WORKFLOWS_DIRECTORY)).filter((name) =>
            /\.ya?ml$/u.test(name),
        );

        for (const workflowName of workflowNames) {
            const workflow = await readFile(join(WORKFLOWS_DIRECTORY, workflowName), "utf8");
            const releaseCreates = occurrences(workflow, /gh release create\b/gu);
            const marksLatest = occurrences(
                workflow,
                /--latest(?![=])\b|make_latest\s*[=:]\s*["']?true\b/gu,
            );
            const refusesLatest = occurrences(
                workflow,
                /--latest=false\b|make_latest\s*[=:]\s*["']?false\b/gu,
            );

            if (workflowName === HAPPY_AGENT_RELEASE_WORKFLOW) {
                assert.equal(marksLatest, 1, "Happy Agent must explicitly publish as Latest.");
                assert.equal(refusesLatest, 0, "Happy Agent must not opt out of Latest.");
                continue;
            }

            assert.equal(
                marksLatest,
                0,
                `${workflowName} must never mark a GitHub Release as Latest.`,
            );
            assert.equal(
                refusesLatest,
                releaseCreates,
                `${workflowName} must pass --latest=false to every GitHub Release creation.`,
            );
        }
    });
});
