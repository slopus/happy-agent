import type { AnyAgentTool } from "@slopus/happy-agent-base";
import type { Compute } from "../../Compute.js";
import type { FileReadLog } from "../../../impl/FileReadLog.js";
import { kimiBashTool } from "./Bash.js";
import { kimiReadTool } from "./Read.js";
import { kimiWriteTool } from "./Write.js";
import { kimiEditTool } from "./Edit.js";
import { kimiGlobTool } from "./Glob.js";
import { kimiGrepTool } from "./Grep.js";
import { kimiReadMediaFileTool } from "./ReadMediaFile.js";
import { kimiTaskOutputTool } from "./TaskOutput.js";
import { kimiTaskInputTool } from "./TaskInput.js";
import { kimiTaskStopTool } from "./TaskStop.js";

export function assembleKimiComputeTools(
    compute: Compute,
    reads: FileReadLog,
): readonly AnyAgentTool[] {
    return [
        kimiBashTool(compute),
        kimiReadTool(compute, reads),
        kimiWriteTool(compute, reads),
        kimiEditTool(compute, reads),
        kimiGlobTool(compute),
        kimiGrepTool(compute),
        kimiReadMediaFileTool(compute, reads),
        kimiTaskOutputTool(compute),
        kimiTaskInputTool(compute),
        kimiTaskStopTool(compute),
    ];
}

export function assembleKimiReviewerTools(
    compute: Compute,
    reads: FileReadLog,
): readonly AnyAgentTool[] {
    return [
        kimiBashTool(compute),
        kimiReadTool(compute, reads),
        kimiGlobTool(compute),
        kimiGrepTool(compute),
        kimiReadMediaFileTool(compute, reads),
        kimiTaskOutputTool(compute),
        kimiTaskInputTool(compute),
    ];
}
