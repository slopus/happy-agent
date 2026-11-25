import type { AnyAgentTool } from "@slopus/happy-agent-base";

import type { ChatMediaModule } from "../../../chatMedia/index.js";
import type { Compute } from "../../Compute.js";
import type { FileReadLog } from "../../../impl/FileReadLog.js";
import { claudeBashTool } from "../claude/Bash.js";
import { claudeBashInputTool } from "../claude/BashInput.js";
import { claudeBashOutputTool } from "../claude/BashOutput.js";
import { claudeBashStopTool } from "../claude/BashStop.js";
import { claudeEditTool } from "../claude/Edit.js";
import { claudeGlobTool } from "../claude/Glob.js";
import { claudeGrepTool } from "../claude/Grep.js";
import { claudeReadTool } from "../claude/Read.js";
import { claudeWriteTool } from "../claude/Write.js";
import { claudeShellName } from "../claude/impl/claudeShellName.js";

/**
 * Antigravity's machine: Claude-shaped shell and file tools, reached over MCP.
 *
 * Happy runs Antigravity with none of its own file, terminal or sub-agent tools, so these are the
 * only way it touches the machine, under Happy's sandbox and reviewer. Gemini has no harness of
 * its own to match, and Claude's names are the most widely known shell and file surface.
 */
export function assembleAntigravityComputeTools(
    compute: Compute,
    reads: FileReadLog,
    outputWaitsReleased: AbortSignal | undefined,
    chatMedia: ChatMediaModule | undefined,
): readonly AnyAgentTool[] {
    const shell = claudeShellName(compute);
    return [
        claudeBashTool(compute, shell),
        claudeBashOutputTool(compute, shell, outputWaitsReleased),
        claudeBashInputTool(compute, shell),
        claudeBashStopTool(compute, shell),
        claudeReadTool(compute, reads, chatMedia),
        claudeWriteTool(compute, reads),
        claudeEditTool(compute, reads),
        claudeGlobTool(compute),
        claudeGrepTool(compute),
    ];
}
