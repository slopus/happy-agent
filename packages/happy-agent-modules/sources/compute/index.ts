/**
 * The public surface of the compute module: the machine an agent works on.
 *
 * Everything below this line — the path arithmetic, the boundary checks, the per-vendor tool
 * implementations, the read log's bookkeeping — belongs to the module. Another module that needs
 * one of those answers asks `ComputeModule` for it rather than reaching into `impl/`.
 */

export {
    ComputeModule,
    agentComputeConfigSchema,
    hostComputeSchema,
    type AgentComputeConfig,
    type ComputeAbortSnapshot,
    type HostCompute,
    type HostComputeProvider,
} from "./ComputeModule.js";
export {
    computeFileDiffHunkSchema,
    computeFileDiffLineSchema,
    computeFileDiffPresentationSchema,
    computeFileDiffSchema,
    MAX_COMPUTE_FILE_DIFF_PRESENTATION_FILES,
    MAX_COMPUTE_FILE_DIFF_PRESENTATION_LINES,
    MAX_COMPUTE_FILE_DIFF_PRESENTATION_TEXT_CHARACTERS,
    type ComputeFileDiff,
    type ComputeFileDiffHunk,
    type ComputeFileDiffLine,
    type ComputeFileDiffPresentation,
} from "./ComputeToolPresentation.js";
export {
    computeProcessChangesSchema,
    computeProcessEventListenerSchema,
    computeProcessEventSchema,
    computeProcessSchema,
    computeProcessStatusSchema,
    MAX_RETAINED_EXITED_PROCESSES,
    MAX_RETAINED_EXITED_PROCESSES_PER_AGENT,
    type ComputeProcess,
    type ComputeProcessChanges,
    type ComputeProcessEvent,
    type ComputeProcessEventListener,
    type ComputeProcessStatus,
    type ComputeProcessUnsubscribe,
} from "./ComputeProcess.js";
export { createComputeModules, type CreatedComputeModules } from "./createComputeModules.js";
export type {
    Compute,
    ComputeFileStat,
    ComputeFileSystem,
    ComputePermissions,
    ComputeRunOptions,
    ComputeSessionActivity,
    ComputeSessionExit,
    ComputeSessionReadOptions,
    ComputeSessionSnapshot,
    ComputeSessionStatus,
    ComputeShell,
} from "./Compute.js";
export {
    computeToolVendor,
    computeToolSelectionSchema,
    computeToolVendorSchema,
    type ComputeToolSelection,
    type ComputeToolVendor,
} from "./ComputeToolVendor.js";
export { assembleComputeTools } from "./tools/assembleComputeTools.js";
export { assembleClaudeComputeTools } from "./tools/claude/assembleClaudeComputeTools.js";
export { assembleCodexComputeTools } from "./tools/codex/assembleCodexComputeTools.js";
export { assembleGrokComputeTools } from "./tools/grok/assembleGrokComputeTools.js";
