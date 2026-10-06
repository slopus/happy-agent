import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";
import { secretIdSchema } from "../../../secrets/index.js";
import type { Compute } from "../../Compute.js";
import { startComputeCommand } from "../../impl/startComputeCommand.js";
import { boundOutputText } from "../../impl/boundOutputText.js";
import { kimiEscalationProperties } from "./impl/kimiPathPolicy.js";

export function kimiBashTool(compute: Compute) {
    return defineAgentTool({
        name: "Bash",
        defer: false,
        capabilities: [
            "Read and modify files, run shell commands, inspect images, and manage background processes.",
        ],
        description:
            "Execute a command in the environment's shell. Each call starts in the primary working directory; cwd selects another directory for this call. Prefer Read, Write, Edit, Glob, and Grep for file work. timeout is the foreground wait in seconds, default 60, maximum 300. A command that outlives the wait keeps running in the background and returns a task_id. run_in_background starts it in the background immediately, watching about three seconds for startup. Read new output with TaskOutput, send characters with TaskInput, and stop the process tree with TaskStop. Completion notifications arrive automatically. secrets selects attached secret bundles for this command; selection is reviewed independently of sandbox escalation.",
        parameters: Type.Object(
            {
                command: Type.String({ minLength: 1, description: "The command to execute." }),
                cwd: Type.Optional(
                    Type.String({
                        description:
                            "Working directory for this command; defaults to the primary working directory.",
                    }),
                ),
                timeout: Type.Optional(
                    Type.Integer({
                        minimum: 1,
                        maximum: 300,
                        default: 60,
                        description:
                            "Foreground wait in seconds. A command that outlives this wait keeps running in the background.",
                    }),
                ),
                run_in_background: Type.Optional(
                    Type.Boolean({
                        description: "Start as a background shell task, with a brief startup wait.",
                    }),
                ),
                tty: Type.Optional(
                    Type.Boolean({
                        description:
                            "Happy extension: run under a terminal for interactive programs. Defaults to false.",
                    }),
                ),
                description: Type.Optional(
                    Type.String({ description: "Short description of the command's purpose." }),
                ),
                ...kimiEscalationProperties,
                secrets: Type.Optional(
                    Type.Array(secretIdSchema, {
                        maxItems: 256,
                        uniqueItems: true,
                        description:
                            "Attached secret bundle IDs needed by this exact command. Omit or pass an empty array for none.",
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object(
            {
                stdout: Type.String(),
                stderr: Type.String(),
                exit_code: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
                task_id: Type.Optional(Type.String()),
                truncated: Type.Boolean(),
            },
            { additionalProperties: false },
        ),
        durable: false,
        autoPermissionInstructions:
            "Commands stay sandboxed by default. sandbox_permissions: require_escalated requests review and temporary Full access for one command. Secret selection is reviewed separately and stays sandboxed. Read only and Workspace write never elevate.",
        describeAutoPermissionAction: (input) =>
            `Running ${JSON.stringify(input.command)} in ${JSON.stringify(input.cwd ?? compute.cwd)} ${input.sandbox_permissions === "require_escalated" ? "outside the workspace sandbox with unrestricted filesystem and network access" : "inside the current workspace sandbox"}. Secret bundles: ${JSON.stringify(input.secrets ?? [])}.${input.justification === undefined ? "" : ` Reason: ${input.justification}`}`,
        shouldReviewInAutoMode: (input) =>
            input.sandbox_permissions === "require_escalated" || (input.secrets?.length ?? 0) > 0,
        shouldRunInFullAccessInAutoMode: (input) =>
            input.sandbox_permissions === "require_escalated",
        execute: async (ctx, input) => {
            if (ctx.lifetime?.aborted) throw new Error("Command cancelled before execution.");
            const { snapshot: result } = await startComputeCommand(compute, ctx, {
                command: input.command,
                waitMs: (input.timeout ?? 60) * 1000,
                maxOutputBytes: 512_000,
                ...(input.cwd === undefined ? {} : { workdir: input.cwd }),
                ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
                ...(input.run_in_background === true ? { background: true } : {}),
                ...(input.tty === undefined ? {} : { tty: input.tty }),
            });
            const stdout = boundOutputText(result.stdoutDelta, { maxCharacters: 60_000 });
            const stderr = boundOutputText(result.stderrDelta, { maxCharacters: 60_000 });
            return {
                stdout: stdout.text,
                stderr: stderr.text,
                ...(result.status === "running"
                    ? { task_id: String(result.sessionId) }
                    : { exit_code: result.exitCode }),
                truncated:
                    stdout.truncated ||
                    stderr.truncated ||
                    (result.stdoutDeltaOmittedBytes ?? 0) + (result.stderrDeltaOmittedBytes ?? 0) >
                        0,
            };
        },
        isError: (result) => result.exit_code !== undefined && result.exit_code !== 0,
        toLLM: (result) => [
            {
                type: "text",
                text:
                    [
                        result.stdout,
                        result.stderr,
                        result.task_id === undefined
                            ? result.exit_code === null
                                ? "Command was stopped before it exited."
                                : result.exit_code !== 0
                                  ? `Command failed with exit code: ${result.exit_code}`
                                  : ""
                            : `Task ${result.task_id} keeps running in the background. Completion will be reported automatically. Use TaskOutput for new output, TaskInput for stdin, and TaskStop to cancel it.`,
                    ]
                        .filter(Boolean)
                        .join("\n") || "Command executed successfully.",
            },
        ],
    });
}
