import type { AnyAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { codexExecCommandTool } from "./exec_command.js";
import { codexWriteStdinTool } from "./write_stdin.js";

/**
 * The read-only slice of Codex's machine the automatic permission reviewer is trusted with.
 *
 * Codex's guardian investigates local state with the shell, so the reviewer keeps `exec_command`
 * and the seam that types into a running session, `write_stdin`, and nothing else. This mirrors Happy Agent
 * v1 exactly, where only `exec_command` and `write_stdin` carried `availableToPermissionReviewer:
 * true`; `kill_session`, `apply_patch`, and `view_image` were not flagged and so are absent here.
 * There is no `apply_patch`, so a review can run commands but never write a file through the patch
 * tool. Every review runs `read_only`, and the compute sandbox is the real boundary for redirection
 * and subprocesses. The array is written out in Codex's own order, not filtered from a larger one.
 */
export function assembleCodexReviewerTools(compute: Compute): readonly AnyAgentTool[] {
    return [codexExecCommandTool(compute), codexWriteStdinTool(compute)];
}
