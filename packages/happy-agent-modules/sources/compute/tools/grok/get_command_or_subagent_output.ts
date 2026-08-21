import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { boundOutputText } from "../../impl/boundOutputText.js";
import { readComputeCommand } from "../../impl/readComputeCommand.js";
import { parseGrokTaskId } from "./impl/parseGrokTaskId.js";

/** The longest one call may wait for the commands it was given to finish. */
const MAX_TIMEOUT_MS = 600_000;

/** How many tasks one call may ask about. */
const MAX_TASK_IDS = 20;

/** How much of one command's new output the answer may carry. */
const MAX_OUTPUT_CHARACTERS = 40_000;

/** What one task in the answer looks like. */
const taskOutputSchema = Type.Object({
    task_id: Type.String(),
    command: Type.Optional(Type.String()),
    status: Type.String(),
    exit_code: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    output: Type.String(),
    truncated: Type.Boolean(),
});

/** Grok's `get_command_or_subagent_output`, scoped here to the background commands this machine runs. */
export function grokGetCommandOrSubagentOutputTool(compute: Compute) {
    return defineAgentTool({
        name: "get_command_or_subagent_output",
        description: `Get output and status for one or more background commands.

Usage notes:
- Pass task_ids with the task IDs run_terminal_command handed back; for a single command use a one-element array.
- Only output produced since your last read comes back, so nothing you were told before is repeated.
- Omit timeout_ms or pass 0 for an immediate snapshot; a positive value waits up to that many milliseconds in total for the commands to end.
- A command that has ended keeps answering this for a while, so its last output is never lost.
- This machine runs commands, so a subagent's task ID is not something it can report on.`,
        parameters: Type.Object(
            {
                task_ids: Type.Array(Type.String(), {
                    description:
                        "Task IDs to query. For one command, pass a one-element array. At most 20 IDs.",
                    maxItems: MAX_TASK_IDS,
                    minItems: 1,
                }),
                timeout_ms: Type.Optional(
                    Type.Integer({
                        description:
                            "Maximum wait in milliseconds. A positive value waits; omit or pass 0 to poll.",
                        maximum: MAX_TIMEOUT_MS,
                        minimum: 0,
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object({ results: Type.Array(taskOutputSchema) }),
        // A read consumes what it returns, so repeating one after a
        // restart would answer with nothing and lose the output the first call was carrying.
        // Reading output of work Happy Agent itself started stays inside the machine the agent already
        // has, so there is nothing here for a reviewer to weigh.
        durable: false,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { task_ids, timeout_ms }) => {
            const taskIds = [...new Set(task_ids.map((taskId) => taskId.trim()))].filter(
                (taskId) => taskId.length > 0,
            );
            if (taskIds.length === 0) throw new Error("Provide at least one task ID.");
            // Every ID is checked before anything is read, so one bad ID cannot cost the other
            // commands the output that a read consumes.
            const commandIds = taskIds.map((taskId) => parseGrokTaskId(taskId));
            const deadline = Date.now() + Math.min(MAX_TIMEOUT_MS, timeout_ms ?? 0);
            const results = [];
            for (const [index, commandId] of commandIds.entries()) {
                const taskId = taskIds[index] ?? String(commandId);
                let outcome;
                try {
                    outcome = await readComputeCommand(compute, ctx, {
                        commandId,
                        waitMs: Math.max(0, deadline - Date.now()),
                    });
                } catch (error) {
                    if (ctx.lifetime?.aborted === true) throw error;
                    results.push({
                        task_id: taskId,
                        status: "not_found",
                        output: "",
                        truncated: false,
                    });
                    continue;
                }
                const { snapshot } = outcome;
                const bounded = boundOutputText(
                    [snapshot.stdoutDelta, snapshot.stderrDelta]
                        .filter((part) => part.length > 0)
                        .join("\n"),
                    { maxCharacters: MAX_OUTPUT_CHARACTERS, keep: "tail" },
                );
                results.push({
                    task_id: taskId,
                    command: snapshot.command,
                    status: snapshot.status,
                    ...(snapshot.status === "running" ? {} : { exit_code: snapshot.exitCode }),
                    output: bounded.text,
                    truncated: bounded.truncated,
                });
            }
            return { results };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: result.results
                    .map((task) =>
                        [
                            task.status === "not_found"
                                ? `Task ${task.task_id} is not a background command on this machine.`
                                : task.status === "running"
                                  ? `Task ${task.task_id} is still running: ${task.command ?? ""}`
                                  : task.exit_code === null || task.exit_code === undefined
                                    ? `Task ${task.task_id} has ended without an exit code, which is what a stopped command looks like: ${task.command ?? ""}`
                                    : `Task ${task.task_id} has ended with exit code ${String(task.exit_code)}: ${task.command ?? ""}`,
                            ...(task.status === "not_found"
                                ? []
                                : [task.output.length > 0 ? task.output : "(no new output)"]),
                        ].join("\n"),
                    )
                    .join("\n\n"),
            },
        ],
    });
}
