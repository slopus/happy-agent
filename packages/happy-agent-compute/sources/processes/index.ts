/** Generic process lifecycle machinery shared by the compute backends. */

export { BoundedOutputBuffer } from "./impl/BoundedOutputBuffer.js";
export { isProcessRunning } from "./impl/isProcessRunning.js";
export { isTargetProcessAlive } from "./impl/isTargetProcessAlive.js";
export { killProcessTree } from "./impl/killProcessTree.js";
export {
    isProcessGroupAlive,
    killProcessGroup,
    ProcessGroupReaper,
} from "./impl/ProcessGroupReaper.js";
export {
    ManagedProcess,
    NativeProcessManager,
    type ManagedProcessHooks,
} from "./NativeProcessManager.js";
export { resolveSystemShell } from "./impl/resolveSystemShell.js";
export {
    NON_INTERACTIVE_TERMINAL_ENVIRONMENT,
    startProcessTransport,
    type ProcessTransport,
} from "./impl/startProcessTransport.js";
export { waitForProcessExit } from "./impl/waitForProcessExit.js";
export type {
    ManagedProcessStatus,
    ProcessKillOptions,
    ProcessOutputDelta,
    ProcessRunOptions,
    ProcessRunResult,
    ProcessSnapshot,
    ProcessStartOptions,
} from "./types.js";
