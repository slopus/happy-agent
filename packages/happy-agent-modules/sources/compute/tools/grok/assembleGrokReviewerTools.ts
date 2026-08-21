import type { AnyAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import type { FileReadLog } from "../../../impl/FileReadLog.js";
import { grokGrepTool } from "./grep.js";
import { grokListDirTool } from "./list_dir.js";
import { grokReadFileTool } from "./read_file.js";
import { grokRunTerminalCommandTool } from "./run_terminal_command.js";
import { grokSendCommandInputTool } from "./send_command_input.js";

/**
 * The read-only slice of Grok's machine the automatic permission reviewer is trusted with.
 *
 * A reviewer gathers evidence and never edits, so this is the fixed subset of Grok's tools that only
 * inspect: the terminal, the file reader, the directory listing, the content search, and the seam
 * that types into a command the reviewer already started. It mirrors Happy Agent v1 exactly, where only
 * `read_file`, `grep`, `list_dir`, `run_terminal_command`, and `send_command_input` carried
 * `availableToPermissionReviewer: true`. Grok's `write`, `search_replace`,
 * `get_command_or_subagent_output`, and `kill_command_or_subagent` were not flagged and so are
 * absent here even though that leaves the set looking asymmetric — the reviewer can start a command
 * and feed it input but reads its output through the same run, exactly as v1 did. The array is
 * written out in Grok's own order rather than filtered from the full surface.
 */
export function assembleGrokReviewerTools(
    compute: Compute,
    reads: FileReadLog,
): readonly AnyAgentTool[] {
    return [
        grokRunTerminalCommandTool(compute),
        grokReadFileTool(compute, reads),
        grokListDirTool(compute),
        grokGrepTool(compute),
        grokSendCommandInputTool(compute),
    ];
}
