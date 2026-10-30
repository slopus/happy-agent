import { HAPPY_AGENT_NEWER_DATA_EXIT_CODE } from "@slopus/happy-agent-modules/data-version";

import { AGENT_SOCKET_IN_USE_EXIT_CODE } from "../socket/AgentSocketInUseError.js";
import { describeDaemonExit, type DaemonExit } from "./daemonSupervisorState.js";

/**
 * Set by `start` on the `run` process it spawns: that process becomes the crash supervisor and
 * runs the real daemon as its child. The supervisor removes it from the daemon's environment, so
 * nothing the daemon runs ever inherits it.
 */
export const AGENT_DAEMON_SUPERVISE_ENVIRONMENT = "HAPPY_AGENT_SUPERVISE";

/** How the supervisor paces restarts and decides that a daemon is crash-looping. */
export interface DaemonSupervisorPolicy {
    /** The wait before the first restart; each further quick failure doubles it. */
    readonly initialBackoffMs: number;
    readonly maxBackoffMs: number;
    /** A daemon that ran at least this long before exiting is not part of a crash loop. */
    readonly stableUptimeMs: number;
    /** Consecutive quick failures after which the supervisor stops restarting. */
    readonly maxQuickFailures: number;
}

export const DEFAULT_DAEMON_SUPERVISOR_POLICY: DaemonSupervisorPolicy = {
    initialBackoffMs: 1_000,
    maxBackoffMs: 30_000,
    stableUptimeMs: 60_000,
    maxQuickFailures: 5,
};

export interface SupervisedDaemonProcess {
    readonly pid: number;
    /** Settles once with the process's exit status. */
    readonly exited: Promise<Pick<DaemonExit, "code" | "signal">>;
}

/** What the supervisor is doing, published for `status` and the desktop app. */
export type DaemonSupervisorSnapshot =
    | {
          readonly phase: "running";
          readonly daemonPid: number;
          readonly restarts: number;
          readonly quickFailures: number;
          readonly lastExit?: DaemonExit;
      }
    | {
          readonly phase: "restarting";
          readonly restarts: number;
          readonly quickFailures: number;
          readonly lastExit: DaemonExit;
          readonly nextRestartAt: number;
      }
    | {
          readonly phase: "gave-up";
          readonly restarts: number;
          readonly quickFailures: number;
          readonly lastExit: DaemonExit;
      }
    | {
          /** The daemon refused data a newer release wrote; restarting cannot help. */
          readonly phase: "refused";
          readonly restarts: number;
          readonly quickFailures: number;
          readonly lastExit: DaemonExit;
      };

export interface DaemonSupervisorDependencies {
    spawnDaemon(): Promise<SupervisedDaemonProcess>;
    /** Whether an intentional stop was recorded for exactly this daemon process. */
    consumeStopIntent(pid: number): Promise<boolean>;
    /** Whether a daemon other than `exitedPid` now serves this Happy home. */
    otherDaemonRunning(exitedPid: number | undefined): Promise<boolean>;
    publish(snapshot: DaemonSupervisorSnapshot): Promise<void>;
    /** Withdraw the published state; the daemon is no longer supervised. */
    release(): Promise<void>;
    log(line: string): void;
    now(): number;
    /** Resolves after `ms`, or early once `signal` aborts. */
    sleep(ms: number, signal: AbortSignal): Promise<void>;
    /** Aborts when the supervisor itself is told to stop. */
    readonly stopSignal: AbortSignal;
}

export type DaemonSupervisorOutcome =
    | {
          readonly kind: "stopped";
          readonly reason: "clean-exit" | "stop-intent" | "supervisor-stopped" | "replaced";
      }
    | { readonly kind: "gave-up"; readonly lastExit: DaemonExit }
    | { readonly kind: "refused"; readonly lastExit: DaemonExit }
    | { readonly kind: "socket-in-use"; readonly lastExit: DaemonExit };

/**
 * Keeps one daemon process alive across unexpected exits.
 *
 * Only an abnormal exit restarts the daemon. A clean exit, or any exit after a recorded
 * intentional stop, ends supervision, and so does a daemon refusing data a newer release wrote
 * or finding its socket already served, so `stop`, `kill`, `reload`, the shutdown API, and an
 * uninstall never fight a respawn. Restarts back off exponentially; after
 * `maxQuickFailures` consecutive exits that each came within `stableUptimeMs` of their start,
 * the supervisor publishes `gave-up` and exits instead of looping forever.
 */
export async function superviseAgentDaemon(
    dependencies: DaemonSupervisorDependencies,
    policy: DaemonSupervisorPolicy = DEFAULT_DAEMON_SUPERVISOR_POLICY,
): Promise<DaemonSupervisorOutcome> {
    const { stopSignal } = dependencies;
    let restarts = 0;
    let quickFailures = 0;
    let lastExit: DaemonExit | undefined;
    for (;;) {
        if (stopSignal.aborted) return await stopped(dependencies, "supervisor-stopped");
        const startedAt = dependencies.now();
        let pid: number | undefined;
        let status: Pick<DaemonExit, "code" | "signal">;
        try {
            const child = await dependencies.spawnDaemon();
            pid = child.pid;
            await dependencies.publish({
                phase: "running",
                daemonPid: pid,
                restarts,
                quickFailures,
                ...(lastExit === undefined ? {} : { lastExit }),
            });
            const exited = await untilAborted(child.exited, stopSignal);
            // A supervisor told to stop leaves its daemon running and simply stops watching.
            if (exited === undefined) return await stopped(dependencies, "supervisor-stopped");
            status = exited;
        } catch (error) {
            dependencies.log(
                `supervisor: could not start the daemon: ${error instanceof Error ? error.message : String(error)}`,
            );
            status = { code: null, signal: null };
        }
        const uptimeMs = Math.max(0, Math.round(dependencies.now() - startedAt));
        const intended = pid !== undefined && (await dependencies.consumeStopIntent(pid));
        if (status.code === 0 && status.signal === null) {
            return await stopped(dependencies, "clean-exit");
        }
        lastExit = { at: new Date(dependencies.now()).toISOString(), ...status, uptimeMs };
        // A refusal stays on record even when the daemon was also being stopped, so the desktop
        // app and `status` can still explain why it will not start.
        if (status.code === HAPPY_AGENT_NEWER_DATA_EXIT_CODE && status.signal === null) {
            dependencies.log(
                "supervisor: the daemon refused data written by a newer Happy Agent; it will not be restarted until Happy Agent is updated.",
            );
            await dependencies.publish({ phase: "refused", restarts, quickFailures, lastExit });
            return { kind: "refused", lastExit };
        }
        // Another process serves the socket, so a restart would only fail the same way. When it is
        // a daemon this installation can use, it needs no supervisor from here; when it is not,
        // `start` identifies it and reports or replaces it.
        if (status.code === AGENT_SOCKET_IN_USE_EXIT_CODE && status.signal === null) {
            dependencies.log(
                "supervisor: another process already serves the daemon socket; not restarting.",
            );
            await dependencies.release();
            return { kind: "socket-in-use", lastExit };
        }
        if (intended) return await stopped(dependencies, "stop-intent");
        quickFailures = uptimeMs >= policy.stableUptimeMs ? 1 : quickFailures + 1;
        const exitText = `${describeDaemonExit(status)} after ${formatUptime(uptimeMs)}`;
        if (quickFailures >= policy.maxQuickFailures) {
            dependencies.log(
                `supervisor: the daemon exited unexpectedly with ${exitText}; it failed ${String(quickFailures)} times in a row soon after starting, so it will not be restarted.`,
            );
            await dependencies.publish({ phase: "gave-up", restarts, quickFailures, lastExit });
            return { kind: "gave-up", lastExit };
        }
        const backoffMs = Math.min(
            policy.maxBackoffMs,
            policy.initialBackoffMs * 2 ** (quickFailures - 1),
        );
        dependencies.log(
            `supervisor: the daemon exited unexpectedly with ${exitText}; restarting in ${formatUptime(backoffMs)}.`,
        );
        await dependencies.publish({
            phase: "restarting",
            restarts,
            quickFailures,
            lastExit,
            nextRestartAt: dependencies.now() + backoffMs,
        });
        await dependencies.sleep(backoffMs, stopSignal);
        if (stopSignal.aborted) return await stopped(dependencies, "supervisor-stopped");
        // Someone started a daemon while this one was down; never compete with it.
        if (await dependencies.otherDaemonRunning(pid)) {
            dependencies.log("supervisor: another daemon is already running; not restarting.");
            return await stopped(dependencies, "replaced");
        }
        restarts += 1;
    }
}

async function stopped(
    dependencies: DaemonSupervisorDependencies,
    reason: Extract<DaemonSupervisorOutcome, { kind: "stopped" }>["reason"],
): Promise<DaemonSupervisorOutcome> {
    await dependencies.release();
    return { kind: "stopped", reason };
}

/** The promise's value, or undefined as soon as `signal` aborts. */
function untilAborted<Value>(
    promise: Promise<Value>,
    signal: AbortSignal,
): Promise<Value | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
        const onAbort = () => resolve(undefined);
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener("abort", onAbort);
                reject(error instanceof Error ? error : new Error(String(error)));
            },
        );
    });
}

function formatUptime(ms: number): string {
    if (ms < 1_000) return `${String(ms)} ms`;
    const seconds = Math.round(ms / 1_000);
    if (seconds < 120) return `${String(seconds)} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 120) return `${String(minutes)} min`;
    return `${String(Math.round(minutes / 60))} h`;
}
