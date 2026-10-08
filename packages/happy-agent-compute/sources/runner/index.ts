/** The runner protocol: computes on a dedicated machine, driven by a daemon on another one. */

export { type RunnerChannel, type RunnerChannelReceiver } from "./RunnerChannel.js";
export { createRunnerChannelPair } from "./createRunnerChannelPair.js";
export { createRunnerCompute, type RunnerComputeOptions } from "./createRunnerCompute.js";
export { createRunnerMachine, type RunnerMachineOptions } from "./createRunnerMachine.js";
export {
    RUNNER_COMPUTE_UNKNOWN,
    RunnerBusyError,
    RunnerComputeUnknownError,
    RunnerDisconnectedError,
    RunnerFrameTooLargeError,
    RunnerIncompatibleError,
    RunnerProtocolError,
    RunnerUnavailableError,
} from "./RunnerErrors.js";
export { RunnerHost, type RunnerComputeRequest, type RunnerHostOptions } from "./RunnerHost.js";
export {
    RunnerLink,
    type RunnerComputeHooks,
    type RunnerConnection,
    type RunnerLinkOptions,
    type RunnerLinkStatus,
    type RunnerRequestOptions,
    type RunnerResponse,
    type RunnerStream,
    type RunnerStreamHandlers,
} from "./RunnerLink.js";
export {
    DEFAULT_RUNNER_LEASE_GRACE_MS,
    MAX_RUNNER_COMPUTES,
    MAX_RUNNER_FRAME_BYTES,
    MAX_RUNNER_IN_FLIGHT_REQUESTS,
    MAX_RUNNER_LEASE_GRACE_MS,
    MAX_RUNNER_RETAINED_EVENTS,
    MAX_RUNNER_STREAMS,
    MIN_RUNNER_PROTOCOL_VERSION,
    RUNNER_PROTOCOL_VERSION,
    RUNNER_STREAM_CHUNK_BYTES,
    RUNNER_STREAM_WINDOW_BYTES,
    runnerAcceptedConnectionSchema,
    runnerComputeIdSchema,
    runnerConnectionIdSchema,
    runnerDockerSchema,
    runnerEvents,
    runnerFrameHeaderSchema,
    runnerIdentitySchema,
    runnerMethods,
    runnerProjectPolicySchema,
    runnerStreamChannelSchema,
    runnerStreamIdSchema,
    runnerWatchBatchSchema,
    type RunnerEvent,
    type RunnerEventParams,
    type RunnerFrameHeader,
    type RunnerIdentity,
    type RunnerMethod,
    type RunnerMethodParams,
    type RunnerMethodResult,
    type RunnerDocker,
    type RunnerProjectPolicy,
    type RunnerStreamChannel,
} from "./runnerProtocol.js";
