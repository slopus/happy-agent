export { grokGetSubagentOutputTool } from "./get_subagent_output.js";
export { grokKillSubagentTool } from "./kill_subagent.js";
export { grokSpawnSubagentTool } from "./spawn_subagent.js";
export { grokFollowupSubagentTool } from "./followup_subagent.js";
export { grokWaitSubagentsTool } from "./wait_subagents.js";
import { grokGetSubagentOutputTool } from "./get_subagent_output.js";
import { grokKillSubagentTool } from "./kill_subagent.js";
import { grokSpawnSubagentTool } from "./spawn_subagent.js";
import { grokFollowupSubagentTool } from "./followup_subagent.js";
import { grokWaitSubagentsTool } from "./wait_subagents.js";

export const grokTools = [grokGetSubagentOutputTool, grokKillSubagentTool] as const;

export const grokCollaborationTools = [
    grokSpawnSubagentTool,
    grokFollowupSubagentTool,
    grokWaitSubagentsTool,
] as const;

export const grokLimitedCollaborationTools = [grokFollowupSubagentTool] as const;
