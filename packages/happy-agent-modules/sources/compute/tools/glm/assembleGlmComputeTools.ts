import type { AnyAgentTool } from "@slopus/happy-agent-base";
import type { Compute } from "../../Compute.js";
import type { FileReadLog } from "../../../impl/FileReadLog.js";
import { claudeBashTool } from "../claude/Bash.js";
import { claudeBashInputTool } from "../claude/BashInput.js";
import { claudeBashOutputTool } from "../claude/BashOutput.js";
import { claudeBashStopTool } from "../claude/BashStop.js";
import { claudeEditTool } from "../claude/Edit.js";
import { claudeGlobTool } from "../claude/Glob.js";
import { claudeGrepTool } from "../claude/Grep.js";
import { claudeTextReadTool } from "../claude/Read.js";
import { claudeWriteTool } from "../claude/Write.js";
import { claudeShellName } from "../claude/impl/claudeShellName.js";

/** GLM uses the Claude Code harness's surface, with a reader that returns only text. */
export function assembleGlmComputeTools(
    compute: Compute,
    reads: FileReadLog,
): readonly AnyAgentTool[] {
    const shell = claudeShellName(compute);
    return [
        claudeBashOutputTool(compute, shell),
        claudeBashTool(compute, shell),
        claudeTextReadTool(compute, reads),
        claudeEditTool(compute, reads),
        claudeWriteTool(compute, reads),
        claudeGlobTool(compute),
        claudeGrepTool(compute),
        claudeBashStopTool(compute, shell),
        claudeBashInputTool(compute, shell),
    ];
}

export function assembleGlmReviewerTools(
    compute: Compute,
    reads: FileReadLog,
): readonly AnyAgentTool[] {
    const shell = claudeShellName(compute);
    return [
        claudeBashTool(compute, shell),
        claudeTextReadTool(compute, reads),
        claudeGlobTool(compute),
        claudeGrepTool(compute),
        claudeBashInputTool(compute, shell),
    ];
}
