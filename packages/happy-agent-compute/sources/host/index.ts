/** The host compute: the real filesystem and shell of the current machine. */

export { createHostCompute, type HostComputeOptions } from "./createHostCompute.js";
export { createHostFileSystem, type HostFileSystemOptions } from "./createHostFileSystem.js";
export { createHostShell, type HostShellOptions } from "./createHostShell.js";
export {
    createProtectedPathMonitor,
    type ProtectedPathMonitor,
} from "./impl/createProtectedPathMonitor.js";
export {
    DEFAULT_HOST_COMMAND_TIMEOUT_MS,
    DEFAULT_HOST_MAX_OUTPUT_BYTES,
    HOST_SESSION_STOP_GRACE_MS,
    MAX_ACTIVE_HOST_SESSIONS,
    MAX_RETAINED_HOST_SESSIONS,
} from "./impl/hostSessionLimits.js";

export { localAgentSocketPath, ensurePrivateDirectory } from "./localAgentPaths.js";
