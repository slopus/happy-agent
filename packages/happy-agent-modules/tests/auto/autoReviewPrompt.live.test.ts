import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    REVIEWER_SCENARIOS,
    type ReviewerFamily,
    type ReviewerScenario,
} from "./reviewerEval/reviewerEvalScenarios.js";
import {
    resolveReviewerEvalRoutes,
    runReviewerEval,
    type ReviewerEvalResult,
    type ReviewerEvalRoute,
} from "./reviewerEval/runReviewerEval.js";
import { formatReviewerEvalReport } from "./reviewerEval/scoreReviewerEval.js";

/**
 * A real-model eval of the Auto reviewer prompt: each scenario goes, several times, to the reviewer
 * models Auto uses on this installation's own accounts, with `ask_parent`, `read_agent_history`
 * and the shell answered from the scenario. Run it with `pnpm --filter
 * @slopus/happy-agent-modules eval:auto-review` when changing the reviewer prompt or the
 * `ask_parent` or history behavior; it never runs otherwise. It reports pass rates rather than
 * failing on them, because single model runs vary; the test fails only when a review could not
 * run. The report is written to the repository's `.context/auto-review-eval/`.
 *
 * - `HAPPY_AGENT_AUTO_REVIEW_EVAL=1` enables it (the script sets this).
 * - `HAPPY_AGENT_AUTO_REVIEW_EVAL_FAMILIES`: `claude,codex` by default.
 * - `HAPPY_AGENT_AUTO_REVIEW_EVAL_RUNS`: runs per scenario and route, 3 by default.
 * - `HAPPY_AGENT_AUTO_REVIEW_EVAL_ONLY`: comma-separated scenario ID prefixes, such as `s3,s4`.
 * - `HAPPY_AGENT_AUTO_REVIEW_EVAL_HOME`: the installation root to take accounts from, `~/.happy`
 *   by default.
 */
const ENABLED = process.env.HAPPY_AGENT_AUTO_REVIEW_EVAL === "1";
const CONCURRENCY = 6;
const REPORT_DIRECTORY = fileURLToPath(
    new URL("../../../../.context/auto-review-eval", import.meta.url),
);

function listSetting(name: string, fallback: string): string[] {
    return (process.env[name] ?? fallback)
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
}

describe.skipIf(!ENABLED)("Auto reviewer prompt on real reviewer models", () => {
    it("reports how each reviewer investigates and decides every scenario", async () => {
        const ctx = createRootContext().named("auto-review-eval");
        const families = listSetting("HAPPY_AGENT_AUTO_REVIEW_EVAL_FAMILIES", "claude,codex");
        const only = listSetting("HAPPY_AGENT_AUTO_REVIEW_EVAL_ONLY", "");
        const runs = Number(process.env.HAPPY_AGENT_AUTO_REVIEW_EVAL_RUNS ?? "3");
        const scenarios = REVIEWER_SCENARIOS.filter(
            (scenario) => only.length === 0 || only.some((id) => scenario.id.startsWith(id)),
        );
        const routes = await resolveReviewerEvalRoutes(
            families as ReviewerFamily[],
            process.env.HAPPY_AGENT_AUTO_REVIEW_EVAL_HOME,
        );

        const jobs: { scenario: ReviewerScenario; route: ReviewerEvalRoute; run: number }[] = [];
        for (const scenario of scenarios)
            for (const route of routes)
                for (let run = 1; run <= runs; run++) jobs.push({ scenario, route, run });
        const results: ReviewerEvalResult[] = [];
        const failures: string[] = [];
        let next = 0;
        await Promise.all(
            Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
                while (next < jobs.length) {
                    const { scenario, route, run } = jobs[next++]!;
                    try {
                        results.push(await runReviewerEval(ctx, scenario, route, run));
                    } catch (error) {
                        failures.push(
                            `${scenario.id} on ${route.route.modelId} #${run}: ${error instanceof Error ? error.message : String(error)}`,
                        );
                    }
                }
            }),
        );
        results.sort((a, b) => a.route.localeCompare(b.route) || a.run - b.run);

        const report = formatReviewerEvalReport(scenarios, results);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await mkdir(REPORT_DIRECTORY, { recursive: true });
        await writeFile(join(REPORT_DIRECTORY, `${stamp}.md`), `${report}\n`);
        await writeFile(
            join(REPORT_DIRECTORY, `${stamp}.jsonl`),
            results.map((result) => JSON.stringify(result)).join("\n") + "\n",
        );
        console.log(`${report}\n\nWritten to ${join(REPORT_DIRECTORY, stamp)}.{md,jsonl}`);
        expect(failures).toEqual([]);
        expect(results.filter((result) => result.outcome === "unparsed")).toEqual([]);
    }, 1_800_000);
});
