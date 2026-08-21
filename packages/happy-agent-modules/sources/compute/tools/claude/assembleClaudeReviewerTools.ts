import type { AnyAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import type { FileReadLog } from "../../../impl/FileReadLog.js";
import { claudeBashTool } from "./Bash.js";
import { claudeBashInputTool } from "./BashInput.js";
import { claudeGlobTool } from "./Glob.js";
import { claudeGrepTool } from "./Grep.js";
import { claudeReadTool } from "./Read.js";

/**
 * The read-only slice of Claude's machine the automatic permission reviewer is trusted with.
 *
 * A reviewer looks; it never changes the workspace. So this is the fixed subset of Claude's coding
 * tools that only gather evidence — the file reader, the search and glob tools, the shell, and the
 * seam that types into a shell the reviewer already started — and nothing that writes. It mirrors
 * Happy Agent v1 exactly, where each of these tools, and only these, carried `availableToPermissionReviewer:
 * true`: `Read`, `Grep`, `Glob`, `Bash`, and the seam that types into a shell. Claude's `Edit`,
 * `Write`, `BashOutput`, and `BashStop` were deliberately not flagged, so they are deliberately
 * absent here too. The array
 * is written out in Claude's own order rather than filtered from the full surface: what the reviewer
 * can do is exactly what this list says, decided once, here.
 */
export function assembleClaudeReviewerTools(
    compute: Compute,
    reads: FileReadLog,
): readonly AnyAgentTool[] {
    return [
        claudeBashTool(compute),
        claudeReadTool(compute, reads),
        claudeGlobTool(compute),
        claudeGrepTool(compute),
        claudeBashInputTool(compute),
    ];
}
