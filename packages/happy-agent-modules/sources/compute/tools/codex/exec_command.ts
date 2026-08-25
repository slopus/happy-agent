import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { startComputeCommand } from "../../impl/startComputeCommand.js";
import {
    createUnifiedExecOutput,
    formatUnifiedExecOutput,
    unifiedExecOutputSchema,
} from "./impl/unifiedExecOutput.js";

/** How long Codex waits for a command when the model does not say. */
const DEFAULT_YIELD_TIME_MS = 10_000;

/** Vanilla Codex keeps up to 1 MiB per unified-exec output stream before model truncation. */
const CODEX_UNIFIED_EXEC_CAPTURE_MAX_BYTES = 1024 * 1024;

/** The window Codex allows around that wait. Beyond it the command is simply left running. */
const MINIMUM_YIELD_TIME_MS = 250;
const MAXIMUM_YIELD_TIME_MS = 30_000;

/** Codex's own tool for running a command and, when it outlasts the wait, keeping it. */
export function codexExecCommandTool(compute: Compute) {
    return defineAgentTool({
        name: "exec_command",
        defer: false,
        capabilities: [
            "Read and modify files, run shell commands, inspect images, and manage background processes.",
        ],
        description: "Runs a command, returning output or a session ID for ongoing interaction.",
        parameters: Type.Object(
            {
                cmd: Type.String({ description: "Shell command to execute." }),
                workdir: Type.Optional(
                    Type.String({
                        description: "Working directory for the command. Defaults to the turn cwd.",
                    }),
                ),
                yield_time_ms: Type.Optional(
                    Type.Number({
                        description:
                            "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms. Reaching it leaves the command running and hands back a session ID rather than killing it.",
                    }),
                ),
                max_output_tokens: Type.Optional(
                    Type.Number({
                        description:
                            "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.",
                    }),
                ),
                shell: Type.Optional(
                    Type.String({
                        description:
                            "Shell binary to launch. Defaults to the machine's default shell.",
                    }),
                ),
                tty: Type.Optional(
                    Type.Boolean({
                        description:
                            "Run the command under a PTY, for programs that behave differently without a terminal. Defaults to false, which uses pipes.",
                    }),
                ),
                sandbox_permissions: Type.Optional(
                    Type.Union([Type.Literal("use_default"), Type.Literal("require_escalated")], {
                        description:
                            "Request reviewed execution outside the workspace sandbox in Auto mode. Defaults to use_default.",
                    }),
                ),
                justification: Type.Optional(
                    Type.String({
                        description:
                            "Concise user-facing reason why sandbox escalation is needed. Use only with require_escalated.",
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        returnType: unifiedExecOutputSchema,
        // A command changes the machine and each read consumes output nobody can hand back, so
        // running it again after a restart would be a second, different command.
        durable: false,
        autoPermissionInstructions:
            'For exec_command, request full-access execution with sandbox_permissions: "require_escalated" and include a concise justification. Keep sandbox_permissions at "use_default" or omit it for ordinary commands.',
        describeAutoPermissionAction: ({
            cmd,
            justification,
            sandbox_permissions,
            shell,
            workdir,
        }) =>
            `running ${JSON.stringify(cmd)}. Working directory: ${JSON.stringify(workdir ?? compute.cwd)}. Shell: ${JSON.stringify(shell ?? "the machine's default shell")}. Access: ${
                sandbox_permissions === "require_escalated"
                    ? "unrestricted filesystem and network access outside the workspace sandbox"
                    : "the current workspace sandbox"
            }${justification === undefined ? "" : `. Reason given: ${justification}`}`,
        // A sandboxed command is the ordinary case and needs no reviewer; leaving the sandbox is
        // the whole of what one is asked about here.
        shouldReviewInAutoMode: ({ sandbox_permissions }) =>
            sandbox_permissions === "require_escalated",
        shouldRunInFullAccessInAutoMode: ({ sandbox_permissions }) =>
            sandbox_permissions === "require_escalated",
        execute: async (ctx, { cmd, max_output_tokens, shell, tty, workdir, yield_time_ms }) => {
            const { snapshot, wallTimeSeconds } = await startComputeCommand(compute, ctx, {
                command: cmd,
                ...(workdir === undefined ? {} : { workdir }),
                ...(shell === undefined ? {} : { shell }),
                ...(tty === undefined ? {} : { tty }),
                maxOutputBytes: CODEX_UNIFIED_EXEC_CAPTURE_MAX_BYTES,
                waitMs: Math.max(
                    MINIMUM_YIELD_TIME_MS,
                    Math.min(MAXIMUM_YIELD_TIME_MS, yield_time_ms ?? DEFAULT_YIELD_TIME_MS),
                ),
            });
            return createUnifiedExecOutput(snapshot, wallTimeSeconds, max_output_tokens);
        },
        isError: (result) => result.exit_code !== undefined && result.exit_code !== 0,
        toLLM: (result) => [{ type: "text", text: formatUnifiedExecOutput(result) }],
    });
}
