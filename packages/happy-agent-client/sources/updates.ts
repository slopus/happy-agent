import type { Cuid2, EventCursor, Timestamp } from "./protocol/common.js";
import type { DaemonDrain } from "./protocol/daemon.js";
import type { EventStreamFrame, EventStreamOptions, HappyAgentEvent } from "./protocol/events.js";
import type { SurfaceDocumentLiveFrame } from "./protocol/surfaces.js";
import { EventStreamProtocolError } from "./readEventStream.js";

const INITIAL_RECONNECT_DELAY_MS = 100;
const MAX_RECONNECT_DELAY_MS = 10_000;
const STABLE_CONNECTION_MS = 30_000;
/**
 * How long after a daemon says it is draining its replacement is expected. Until then the feed
 * keeps retrying at its first interval instead of backing off, so it is back within moments of
 * the new process answering rather than seconds after.
 */
const REPLACEMENT_WINDOW_MS = 2 * 60_000;

/** Options for the client's reconnecting event feed. */
export interface HappyAgentUpdatesOptions {
    /** The last event the caller has already applied. */
    after?: EventCursor | undefined;
    /** Stops reconnecting and ends the iteration. */
    signal?: AbortSignal | undefined;
}

/** One item from the client's reconnecting event feed. */
export type HappyAgentUpdate =
    /** `streamId` names this connection for document subscriptions; each reconnect has a new one. */
    | { kind: "connected"; cursor: EventCursor; streamId?: Cuid2 }
    | {
          kind: "daemon_started";
          cursor: EventCursor;
          daemonId: Cuid2;
          daemonStartedAt: Timestamp;
          /** `true` when this replaces a daemon already observed by this iterator. */
          replaced: boolean;
      }
    | {
          kind: "draining";
          cursor: EventCursor;
          daemonId?: Cuid2;
          /** Whether a replacement is coming, and why. Absent on older daemons. */
          drain?: DaemonDrain;
      }
    | { kind: "state_lost"; cursor: EventCursor }
    | { kind: "disconnected"; cursor?: EventCursor }
    | { kind: "event"; event: HappyAgentEvent; cursor: EventCursor }
    /** A live frame for a document subscribed on the current connection; never replayed. */
    | { kind: "document"; frame: SurfaceDocumentLiveFrame };

type OpenEventStream = (options: EventStreamOptions) => AsyncIterable<EventStreamFrame>;

/**
 * Follows the global event stream until the caller aborts it.
 *
 * The accepted cursor advances before an event is yielded, so every reconnect
 * starts strictly after the last event visible to the caller. A resumed
 * stream's hello names the daemon's current head, not the start of its replay,
 * so that value replaces the accepted cursor only for a fresh stream or after
 * an honest gap.
 */
export async function* reconnectingUpdates(
    openEventStream: OpenEventStream,
    options: HappyAgentUpdatesOptions = {},
): AsyncGenerator<HappyAgentUpdate> {
    let cursor = options.after;
    let connection: "initial" | "connected" | "draining" | "disconnected" = "initial";
    let daemonId: Cuid2 | undefined;
    let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    let replacementExpectedUntil = 0;

    while (!isAborted(options.signal)) {
        const attemptStartedAt = Date.now();
        let acceptedEvent = false;
        let receivedHello = false;

        try {
            for await (const frame of openEventStream({
                ...(cursor === undefined ? {} : { after: cursor }),
                ...(options.signal === undefined ? {} : { signal: options.signal }),
            })) {
                if (isAborted(options.signal)) return;

                if (frame.kind === "hello") {
                    if (receivedHello) {
                        throw new EventStreamProtocolError(
                            "An event stream sent more than one hello frame.",
                        );
                    }
                    receivedHello = true;
                    // A daemon that answers without draining is the replacement, or never left.
                    if (frame.hello.draining !== true) replacementExpectedUntil = 0;

                    const stateLost =
                        frame.hello.gap || (cursor !== undefined && !frame.hello.resumed);
                    if (cursor === undefined || stateLost) cursor = frame.hello.cursor;

                    connection = "connected";
                    yield {
                        kind: "connected",
                        cursor,
                        ...(frame.hello.streamId === undefined
                            ? {}
                            : { streamId: frame.hello.streamId }),
                    };
                    if (
                        frame.hello.daemonId !== undefined &&
                        frame.hello.daemonStartedAt !== undefined &&
                        frame.hello.daemonId !== daemonId
                    ) {
                        const replaced = daemonId !== undefined;
                        daemonId = frame.hello.daemonId;
                        yield {
                            kind: "daemon_started",
                            cursor,
                            daemonId,
                            daemonStartedAt: frame.hello.daemonStartedAt,
                            replaced,
                        };
                    }
                    if (stateLost) yield { kind: "state_lost", cursor };
                    if (frame.hello.draining === true) {
                        connection = "draining";
                        replacementExpectedUntil = Date.now() + REPLACEMENT_WINDOW_MS;
                        // Its replacement answers soon, however far this client had backed off.
                        reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
                        yield {
                            kind: "draining",
                            cursor,
                            ...(frame.hello.daemonId === undefined
                                ? {}
                                : { daemonId: frame.hello.daemonId }),
                            ...(frame.hello.drain == null ? {} : { drain: frame.hello.drain }),
                        };
                    }
                    continue;
                }

                if (!receivedHello) {
                    throw new EventStreamProtocolError(
                        "An event stream sent an event before its hello frame.",
                    );
                }
                if (frame.kind === "document") {
                    yield { kind: "document", frame: frame.frame };
                    continue;
                }
                if (cursor !== undefined && frame.cursor <= cursor) continue;

                cursor = frame.cursor;
                acceptedEvent = true;
                yield { kind: "event", event: frame.event, cursor };
                if (frame.event.type === "daemon.draining" && connection !== "draining") {
                    connection = "draining";
                    replacementExpectedUntil = Date.now() + REPLACEMENT_WINDOW_MS;
                    // Its replacement answers soon, however far this client had backed off.
                    reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
                    yield {
                        kind: "draining",
                        cursor,
                        daemonId: frame.event.payload.daemonId,
                        ...(frame.event.payload.drain === undefined
                            ? {}
                            : { drain: frame.event.payload.drain }),
                    };
                }
            }
        } catch {
            if (isAborted(options.signal)) return;
            // A partial response, reset socket, malformed attempt, proxy error,
            // or failed fetch all recover through the same cursor-based retry.
        }

        if (isAborted(options.signal)) return;
        if (connection !== "disconnected") {
            connection = "disconnected";
            yield cursor === undefined
                ? { kind: "disconnected" }
                : { kind: "disconnected", cursor };
        }

        if (
            acceptedEvent ||
            (receivedHello && Date.now() - attemptStartedAt >= STABLE_CONNECTION_MS)
        ) {
            reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
        }
        if (!(await delay(reconnectDelayMs, options.signal))) return;
        if (Date.now() >= replacementExpectedUntil)
            reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    }
}

async function delay(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
    if (isAborted(signal)) return false;
    return await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (completed: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            resolve(completed);
        };
        const timer = setTimeout(() => finish(true), ms);
        const abort = () => finish(false);
        signal?.addEventListener("abort", abort, { once: true });
    });
}

function isAborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
}
