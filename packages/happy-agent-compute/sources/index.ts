/** Public surface of `@slopus/happy-agent-compute`. */

export { type Compute, type ComputeKind } from "./Compute.js";
export {
    computeServiceExecutionSchema,
    computeServicePathSchema,
    computeServiceSandboxSchema,
    computeServiceStartSchema,
    type ComputeService,
    type ComputeServiceExecution,
    type ComputeServiceExit,
    type ComputeServiceOutput,
    type ComputeServiceOutputPosition,
    type ComputeServiceSandbox,
    type ComputeServices,
    type ComputeServiceStartOptions,
} from "./ComputeServices.js";
export {
    ServiceEndpointUnavailableError,
    ServiceTeardownError,
} from "./services/ServiceRuntimeErrors.js";
export {
    computeHostPolicySchema,
    EMPTY_COMPUTE_HOST_POLICY,
    type ComputeHostPolicy,
} from "./ComputeHostPolicy.js";
export { type ComputeConfigOf, type ComputeProvider } from "./ComputeProvider.js";
export { ComputeProviders } from "./ComputeProviders.js";
export {
    type ComputeDirectoryPage,
    type ComputeDirectoryPageOptions,
    type ComputeFileStat,
    type ComputeFileSystem,
    type ComputeReadOptions,
} from "./ComputeFileSystem.js";
export {
    allowEverything,
    assertComputePermissions,
    computeNetworkPermissionsSchema,
    computePermissions,
    computePermissionModeSchema,
    computePermissionsSchema,
    DEFAULT_COMPUTE_PERMISSION_MODE,
    type ComputeNetworkPermissions,
    type ComputePermissionMode,
    type ComputePermissions,
} from "./ComputePermissions.js";
export {
    type ComputeRunOptions,
    type ComputeRunResult,
    type ComputeSessionActivity,
    type ComputeSessionExit,
    type ComputeSessionReadOptions,
    type ComputeSessionSnapshot,
    type ComputeSessionStatus,
    type ComputeShell,
} from "./ComputeShell.js";
export {
    createJustBashCompute,
    type JustBashComputeOptions,
    type JustBashFolderComputeOptions,
    type JustBashMemoryComputeOptions,
} from "./justBash/createJustBashCompute.js";
export {
    createJustBashComputeFromFileSystem,
    type JustBashFileSystemCompute,
    type JustBashFileSystemComputeOptions,
} from "./justBash/createJustBashComputeFromFileSystem.js";
export {
    justBashComputeConfigSchema,
    justBashComputeProvider,
    type JustBashComputeConfig,
} from "./justBash/justBashComputeProvider.js";

// The host compute: the real filesystem and shell of the machine the agent runs on.
export * from "./host/index.js";
export {
    hostComputeConfigSchema,
    hostComputeProvider,
    type HostComputeConfig,
} from "./host/hostComputeProvider.js";

// The Docker compute: a filesystem and shell inside a container.
export * from "./docker/index.js";

// Process lifecycle machinery the backends share.
export * from "./processes/index.js";

// Filesystem path and environment helpers used by the backends.
export * from "./sandbox/index.js";

// Project-network policy data and low-level helpers; restricted compute egress uses the native
// supervisor directly.
export * from "./network/index.js";

// Native supervisor policy translation used by restricted host and Docker commands.
export * from "./supervisor/index.js";
