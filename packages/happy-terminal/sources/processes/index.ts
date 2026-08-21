export { killProcessTree } from "./killProcessTree.js";
export { isTargetProcessAlive } from "./isTargetProcessAlive.js";
export { BoundedOutputBuffer } from "./BoundedOutputBuffer.js";
export { ManagedProcess, NativeProcessManager } from "./NativeProcessManager.js";
export { resolveSystemShell } from "./resolveSystemShell.js";
export { waitForProcessExit } from "./waitForProcessExit.js";
export type {
    ManagedProcessStatus,
    ProcessKillOptions,
    ProcessRunOptions,
    ProcessRunResult,
    ProcessSnapshot,
    ProcessStartOptions,
} from "./types.js";
