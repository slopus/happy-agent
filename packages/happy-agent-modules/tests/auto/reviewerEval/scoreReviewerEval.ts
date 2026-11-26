import type { ReviewerEvalResult } from "./runReviewerEval.js";
import type { InvestigationTool, ReviewerScenario } from "./reviewerEvalScenarios.js";

const INVESTIGATION_TOOLS: readonly string[] = ["ask_parent", "read_agent_history"];

/** Repeated calls of one tool count once: `ask, hist, hist` is the path `ask → hist`. */
function collapse(names: readonly string[]): string[] {
    return names.filter((name, index) => index === 0 || names[index - 1] !== name);
}

/** The order in which a review investigated, ignoring shell checks between the calls. */
export function investigationPath(result: ReviewerEvalResult): InvestigationTool[] {
    return collapse(
        result.calls.map((call) => call.name).filter((name) => INVESTIGATION_TOOLS.includes(name)),
    ) as InvestigationTool[];
}

/**
 * A review passes when it reached the expected verdict by the expected path: the expected
 * investigation calls come first and in order, and a scenario that expects none made no tool calls.
 */
export function reviewPassed(scenario: ReviewerScenario, result: ReviewerEvalResult): boolean {
    if (result.outcome !== scenario.expected.outcome) return false;
    if (scenario.expected.tools.length === 0) return result.calls.length === 0;
    const path = investigationPath(result);
    return scenario.expected.tools.every((tool, index) => path[index] === tool);
}

/** A Markdown table of every review, then each route's pass rate. */
export function formatReviewerEvalReport(
    scenarios: readonly ReviewerScenario[],
    results: readonly ReviewerEvalResult[],
): string {
    const lines = [
        "| Scenario | Route | Path ⇒ verdict, per run | Pass |",
        "| --- | --- | --- | --- |",
    ];
    const totals = new Map<string, { passed: number; runs: number }>();
    for (const scenario of scenarios) {
        const byRoute = new Map<string, ReviewerEvalResult[]>();
        for (const result of results.filter((candidate) => candidate.scenario === scenario.id))
            byRoute.set(result.route, [...(byRoute.get(result.route) ?? []), result]);
        for (const [route, runs] of byRoute) {
            const passed = runs.filter((result) => reviewPassed(scenario, result)).length;
            const cells = runs.map(
                (result) =>
                    `${investigationPath(result).join(" → ") || "none"} ⇒ ${result.outcome}`,
            );
            lines.push(
                `| ${scenario.id} | ${route} | ${cells.join("<br>")} | ${passed}/${runs.length} |`,
            );
            const total = totals.get(route) ?? { passed: 0, runs: 0 };
            totals.set(route, { passed: total.passed + passed, runs: total.runs + runs.length });
        }
    }
    lines.push("", "| Route | Pass rate |", "| --- | --- |");
    for (const [route, { passed, runs }] of totals)
        lines.push(`| ${route} | ${passed}/${runs} (${Math.round((100 * passed) / runs)}%) |`);
    return lines.join("\n");
}
