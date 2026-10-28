import { withAgentPermissionMode, type AgentPermissionMode } from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";

import { agentOptions, workflowWorld, WORKFLOW_OWNER } from "./support/workflowWorld.js";

/** Monty loads and runs a real interpreter, so a run is slower than an ordinary unit test. */
const RUN_TIMEOUT = 30_000;

const SCRIPT = `agent("Review the parser.", ${agentOptions("Review")})`;

/** A tool call the module never asks anything of except its identity. */
function toolCall(id: string) {
    return { id, kv: undefined, commit: async (_ctx: unknown, result: unknown) => result } as never;
}

describe("workflow agent permission modes", () => {
    it.each(["read_only", "workspace_write", "auto", "full_access"] as const)(
        "starts a %s owner's agents in that mode",
        async (mode: AgentPermissionMode) => {
            const world = await workflowWorld(`workflows-mode-${mode}`);
            try {
                const run = (await world.tools(mode)).find((tool) => tool.name === "run_workflow");
                if (run === undefined) throw new Error("Expected run_workflow.");

                await run.execute(world.ctx, { input: { script: SCRIPT } }, toolCall("run-mode"));
                const [collaborator] = await world.collaborators.waitFor(1);
                await world.answer(collaborator!, "Fine.");
                await world.module.whenRunsSettle();

                expect(collaborator?.options.creatorPermissionMode).toBe(mode);
            } finally {
                world.close();
            }
        },
        RUN_TIMEOUT,
    );

    it(
        "does not hand its agents the Full access an Auto review lent run_workflow",
        async () => {
            const world = await workflowWorld("workflows-mode-elevated");
            try {
                const run = (await world.tools("auto")).find(
                    (tool) => tool.name === "run_workflow",
                );
                if (run === undefined) throw new Error("Expected run_workflow.");

                // A script read off disk is elevated for that one call after review.
                await run.execute(
                    withAgentPermissionMode(world.ctx, "full_access"),
                    { input: { script: SCRIPT } },
                    toolCall("run-elevated"),
                );
                const [collaborator] = await world.collaborators.waitFor(1);
                await world.answer(collaborator!, "Fine.");
                await world.module.whenRunsSettle();

                expect(collaborator?.options.creatorPermissionMode).toBe("auto");
            } finally {
                world.close();
            }
        },
        RUN_TIMEOUT,
    );

    it(
        "keeps the owner's mode for agents a run starts after a restart",
        async () => {
            const world = await workflowWorld("workflows-mode-restart");
            try {
                await world.module.launch(
                    world.ctx,
                    WORKFLOW_OWNER,
                    {
                        script: [SCRIPT, `agent("Summarize.", ${agentOptions("summary")})`].join(
                            "\n",
                        ),
                    },
                    "run-restart",
                    "read_only",
                );
                const [first] = await world.collaborators.waitFor(1);

                // The process stops while the first agent works; the next one starts from the
                // restored run, whose context names no agent.
                const restarted = await world.restart();
                await restarted.hooks.afterStart?.(restarted.ctx, undefined as never);
                await restarted.answer(first!, "First.");
                const summary = await restarted.collaborators.byTitle("summary");
                await restarted.answer(summary, "Done.");
                await restarted.module.whenRunsSettle();

                expect(first?.options.creatorPermissionMode).toBe("read_only");
                expect(summary.options.creatorPermissionMode).toBe("read_only");
            } finally {
                world.close();
            }
        },
        RUN_TIMEOUT,
    );
});
