import { describe, expect, it } from "vitest";

import { workflowWorld, WORKFLOW_OWNER } from "./support/workflowWorld.js";

/** Monty loads and runs a real interpreter, so a run is slower than an ordinary unit test. */
const RUN_TIMEOUT = 30_000;

const TOOL_NAMES = [
    "run_workflow",
    "list_workflows",
    "workflow_status",
    "cancel_workflow",
    "resume_workflow",
    "wait_workflow",
    "workflow_logs",
];

/** Start one run of a script that finishes on its own, and wait for it. */
async function runScript(
    world: Awaited<ReturnType<typeof workflowWorld>>,
    id: string,
    script: string,
    name?: string,
): Promise<void> {
    await world.module.launch(
        world.ctx,
        WORKFLOW_OWNER,
        name === undefined ? { script } : { script, name },
        id,
    );
    await world.module.whenRunsSettle();
}

describe("workflow reading", () => {
    it(
        "records the notes a script wrote and pages through them",
        async () => {
            const world = await workflowWorld("workflows-logs");
            try {
                await runScript(
                    world,
                    "run-logs",
                    [
                        'phase("Collecting")',
                        'log("Looked at three files.")',
                        'print("Printed note.")',
                        '"done"',
                    ].join("\n"),
                );

                const all = await world.module.logs(world.ctx, WORKFLOW_OWNER, { id: "run-logs" });
                expect(all.lines.map((line) => line.text)).toEqual([
                    "Phase: Collecting",
                    "Looked at three files.",
                    "Printed note.",
                ]);
                expect(all.totalLines).toBe(3);
                expect(all.nextCursor).toBeUndefined();

                const firstPage = await world.module.logs(world.ctx, WORKFLOW_OWNER, {
                    id: "run-logs",
                    limit: 2,
                });
                expect(firstPage.lines.map((line) => line.position)).toEqual([0, 1]);
                expect(firstPage.nextCursor).toBe(2);
                expect(firstPage.previousCursor).toBeUndefined();

                const lastPage = await world.module.logs(world.ctx, WORKFLOW_OWNER, {
                    id: "run-logs",
                    from: "end",
                    limit: 2,
                });
                expect(lastPage.cursor).toBe(1);
                expect(lastPage.lines.map((line) => line.text)).toEqual([
                    "Looked at three files.",
                    "Printed note.",
                ]);
                expect(lastPage.previousCursor).toBe(0);

                const run = await world.module.status(world.ctx, WORKFLOW_OWNER, "run-logs");
                expect(run?.phase).toBe("Collecting");
                expect(run?.logsTruncated).toBe(false);
            } finally {
                world.close();
            }
        },
        RUN_TIMEOUT,
    );

    it(
        "refuses to read the notes of a run this agent never started",
        async () => {
            const world = await workflowWorld("workflows-logs-unknown");
            try {
                await expect(
                    world.module.logs(world.ctx, WORKFLOW_OWNER, { id: "missing" }),
                ).rejects.toThrow('Workflow run "missing" was not found.');
            } finally {
                world.close();
            }
        },
        RUN_TIMEOUT,
    );

    it(
        "pages an agent's runs and keeps another agent's runs out of them",
        async () => {
            const world = await workflowWorld("workflows-list");
            try {
                await runScript(world, "run-a", '"a"', "first");
                await runScript(world, "run-b", '"b"', "second");
                await runScript(world, "run-c", '"c"', "third");

                const page = await world.module.list(world.ctx, WORKFLOW_OWNER, { limit: 2 });
                expect(page.runs.map((run) => run.id)).toEqual(["run-a", "run-b"]);
                expect(page).toMatchObject({ cursor: 0, totalRuns: 3, nextCursor: 2 });

                const next = await world.module.list(world.ctx, WORKFLOW_OWNER, {
                    cursor: page.nextCursor ?? 0,
                    limit: 2,
                });
                expect(next.runs.map((run) => run.id)).toEqual(["run-c"]);
                expect(next.nextCursor).toBeUndefined();
                expect(next.previousCursor).toBe(0);

                const running = await world.module.list(world.ctx, WORKFLOW_OWNER, {
                    includeTerminal: false,
                });
                expect(running.runs).toEqual([]);

                const other = await world.module.list(world.ctx, "somebodyelse", {});
                expect(other.totalRuns).toBe(0);
                expect(
                    await world.module.status(world.ctx, "somebodyelse", "run-a"),
                ).toBeUndefined();
            } finally {
                world.close();
            }
        },
        RUN_TIMEOUT,
    );
});

describe("workflow tools", () => {
    it(
        "offers the seven workflow tools to the agent that owns the runs",
        async () => {
            const world = await workflowWorld("workflows-tool-surface");
            try {
                const tools = await world.tools();
                expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
                // Reading is committed with the turn; starting, stopping and waiting cannot be,
                // because the work they touch outlives the transaction.
                expect(
                    tools
                        .filter((tool) => tool.durable)
                        .map((tool) => tool.name)
                        .sort(),
                ).toEqual(["list_workflows", "workflow_logs", "workflow_status"]);
                expect(
                    tools
                        .filter((tool) => tool.reloadable)
                        .map((tool) => tool.name)
                        .sort(),
                ).toEqual(["list_workflows", "workflow_logs", "workflow_status"]);
            } finally {
                world.close();
            }
        },
        RUN_TIMEOUT,
    );

    it(
        "exposes nothing at all when workflows are turned off",
        async () => {
            const world = await workflowWorld("workflows-disabled", { enabled: false });
            try {
                expect(await world.tools()).toEqual([]);
                await expect(
                    world.module.launch(world.ctx, WORKFLOW_OWNER, { script: '"a"' }, "run-off"),
                ).rejects.toThrow("Workflows are turned off for this agent.");
            } finally {
                world.close();
            }
        },
        RUN_TIMEOUT,
    );

    it(
        "reviews a workflow script read off disk, and lets an inline one through",
        async () => {
            const world = await workflowWorld("workflows-permissions");
            try {
                const tools = await world.tools();
                const run = tools.find((tool) => tool.name === "run_workflow");
                if (run === undefined) throw new Error("Expected run_workflow.");

                const inline = { input: { script: '"a"' } };
                expect(await run.shouldReviewInAutoMode(inline, world.ctx)).toBe(false);
                expect(await run.shouldRunInFullAccessInAutoMode?.(inline, world.ctx)).toBe(false);
                expect(run.describeAutoPermissionAction?.(inline, world.ctx)).toBe(
                    "starting an inline workflow",
                );

                // This agent has no filesystem of its own, so nothing can judge where the path
                // leads and the reviewer decides.
                const saved = { input: { scriptPath: "plans/review.py" } };
                expect(await run.shouldReviewInAutoMode(saved, world.ctx)).toBe(true);
                expect(await run.shouldRunInFullAccessInAutoMode?.(saved, world.ctx)).toBe(true);
                expect(run.describeAutoPermissionAction?.(saved, world.ctx)).toBe(
                    "reading a workflow script",
                );
                await expect(
                    world.module.launch(
                        world.ctx,
                        WORKFLOW_OWNER,
                        { scriptPath: "plans/review.py" },
                        "run-path",
                    ),
                ).rejects.toThrow("This agent cannot read workflow scripts from disk.");
            } finally {
                world.close();
            }
        },
        RUN_TIMEOUT,
    );

    it(
        "renders every tool's result as something a model can read",
        async () => {
            const world = await workflowWorld("workflows-tool-rendering");
            try {
                await runScript(
                    world,
                    "run-render",
                    'log("Read the parser.")\n"All good."',
                    "look",
                );
                const tools = await world.tools();
                const toolNamed = (name: string) => {
                    const found = tools.find((tool) => tool.name === name);
                    if (found === undefined) throw new Error(`Expected ${name}.`);
                    return found;
                };
                const rendered = (name: string, result: unknown): string => {
                    const blocks = toolNamed(name).toLLM(result);
                    return blocks
                        .map((block) => (block.type === "text" ? block.text : ""))
                        .join("\n");
                };

                const run = await world.module.status(world.ctx, WORKFLOW_OWNER, "run-render");
                const runText = rendered("workflow_status", run);
                expect(runText).toContain("look (run-render) is completed.");
                expect(runText).toContain("Agents started: 0.");
                expect(runText).toContain("Result:\nAll good.");
                expect(runText).toContain("Progress notes:\nRead the parser.");
                expect(rendered("workflow_status", undefined)).toBe(
                    "There is no workflow with that ID.",
                );

                const page = await world.module.list(world.ctx, WORKFLOW_OWNER, {});
                expect(rendered("list_workflows", page)).toBe(
                    "look (run-render) — completed, 0 agents.",
                );
                expect(
                    rendered("list_workflows", {
                        agentId: WORKFLOW_OWNER,
                        cursor: 0,
                        runs: [],
                        totalRuns: 0,
                    }),
                ).toBe("No workflow runs.");

                const logs = await world.module.logs(world.ctx, WORKFLOW_OWNER, {
                    id: "run-render",
                });
                expect(rendered("workflow_logs", logs)).toBe("1. Read the parser.");
                expect(
                    rendered("workflow_logs", {
                        agentId: WORKFLOW_OWNER,
                        id: "run-render",
                        cursor: 0,
                        lines: [],
                        totalLines: 0,
                    }),
                ).toBe("This workflow has recorded no progress notes.");

                // Every run-shaped tool speaks about a run the same way.
                for (const name of ["run_workflow", "cancel_workflow", "resume_workflow"]) {
                    expect(rendered(name, run)).toBe(runText);
                }
                expect(rendered("wait_workflow", run)).toBe(runText);
            } finally {
                world.close();
            }
        },
        RUN_TIMEOUT,
    );

    it(
        "refuses to resume a run that is not paused",
        async () => {
            const world = await workflowWorld("workflows-resume-refusal");
            try {
                await runScript(world, "run-done", '"done"');
                await expect(
                    world.module.resume(world.ctx, WORKFLOW_OWNER, "run-done"),
                ).rejects.toThrow('Workflow run "run-done" is completed.');
                await expect(
                    world.module.resume(world.ctx, WORKFLOW_OWNER, "missing"),
                ).rejects.toThrow('Workflow run "missing" was not found.');
            } finally {
                world.close();
            }
        },
        RUN_TIMEOUT,
    );
});
