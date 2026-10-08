import { MAX_RUNNER_FRAME_BYTES } from "./runnerProtocol.js";

/** The other side broke the protocol; the connection cannot continue. */
export class RunnerProtocolError extends Error {
    override readonly name = "RunnerProtocolError";
    readonly code = "ERUNNERPROTOCOL";
}

/** The daemon and the runner share no protocol version. */
export class RunnerIncompatibleError extends Error {
    override readonly name = "RunnerIncompatibleError";
    readonly code = "ERUNNERINCOMPATIBLE";
}

/** A value is too large to move through the runner protocol in one frame. */
export class RunnerFrameTooLargeError extends Error {
    override readonly name = "RunnerFrameTooLargeError";
    readonly code = "ERUNNERFRAMETOOLARGE";

    constructor(bytes: number) {
        super(
            `This transfer needs ${String(bytes)} bytes, but a runner moves at most ` +
                `${String(MAX_RUNNER_FRAME_BYTES)} bytes in one call.`,
        );
    }
}

/**
 * No runner connection was available, so the request was never sent.
 *
 * Nothing happened on the runner. The caller may try again once the runner is back.
 */
export class RunnerUnavailableError extends Error {
    override readonly name = "RunnerUnavailableError";
    readonly code = "ERUNNERUNAVAILABLE";
}

/**
 * The connection ended while a request was in flight, so its outcome is unknown.
 *
 * The runner may or may not have performed the work. Nothing replays it: a command that ran once
 * must never run twice because a network link dropped.
 */
export class RunnerDisconnectedError extends Error {
    override readonly name = "RunnerDisconnectedError";
    readonly code = "ERUNNERDISCONNECTED";
}

/** The error code a runner answers with when it does not hold the compute a request named. */
export const RUNNER_COMPUTE_UNKNOWN = "ERUNNERCOMPUTEUNKNOWN";

/**
 * The runner does not hold the compute a request named, so it refused the request before doing
 * anything. This happens after the runner restarted or released a daemon that stayed away too long.
 */
export class RunnerComputeUnknownError extends Error {
    override readonly name = "RunnerComputeUnknownError";
    readonly code = RUNNER_COMPUTE_UNKNOWN;

    constructor() {
        super("The runner no longer holds this machine.");
    }
}

/** The runner is already working on as many requests as it accepts at once. */
export class RunnerBusyError extends Error {
    override readonly name = "RunnerBusyError";
    readonly code = "ERUNNERBUSY";
}
