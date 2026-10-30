import { describe, expect, it } from "vitest";

import {
    superviseAgentDaemon,
    type DaemonSupervisorDependencies,
    type DaemonSupervisorPolicy,
    type DaemonSupervisorSnapshot,
} from "../sources/lifecycle/superviseAgentDaemon.js";

const POLICY: DaemonSupervisorPolicy = {
    initialBackoffMs: 1_000,
    maxBackoffMs: 4_000,
    stableUptimeMs: 60_000,
    maxQuickFailures: 3,
};

interface ScriptedExit {
    readonly code: number | null;
    readonly signal: string | null;
    /** How long the daemon runs before this exit. */
    readonly afterMs: number;
    /** Record an intentional stop for this daemon before it exits. */
    readonly intended?: boolean;
}

/**
 * Runs the supervisor against scripted daemon lifetimes on a virtual clock. Each spawn takes the
 * next scripted exit; running out of script leaves the last daemon running until stopped.
 */
function arrange(script: readonly ScriptedExit[], options: { otherDaemon?: boolean } = {}) {
    let clock = 0;
    let nextPid = 100;
    const spawned: number[] = [];
    const sleeps: number[] = [];
    const published: DaemonSupervisorSnapshot[] = [];
    const intents = new Set<number>();
    const stop = new AbortController();
    let released = 0;
    const remaining = [...script];
    const dependencies: DaemonSupervisorDependencies = {
        spawnDaemon: async () => {
            const pid = (nextPid += 1);
            spawned.push(pid);
            const exit = remaining.shift();
            if (exit === undefined) return { pid, exited: new Promise(() => undefined) };
            return {
                pid,
                exited: (async () => {
                    await Promise.resolve();
                    clock += exit.afterMs;
                    if (exit.intended === true) intents.add(pid);
                    return { code: exit.code, signal: exit.signal };
                })(),
            };
        },
        consumeStopIntent: async (pid) => intents.delete(pid),
        otherDaemonRunning: async () => options.otherDaemon === true,
        publish: async (snapshot) => {
            published.push(snapshot);
        },
        release: async () => {
            released += 1;
        },
        log: () => undefined,
        now: () => clock,
        sleep: async (ms) => {
            sleeps.push(ms);
            clock += ms;
        },
        stopSignal: stop.signal,
    };
    return {
        dependencies,
        published,
        sleeps,
        spawned,
        stop,
        get released() {
            return released;
        },
    };
}

describe("superviseAgentDaemon", () => {
    it("restarts a daemon killed by a native crash and keeps watching the replacement", async () => {
        const fixture = arrange([{ code: null, signal: "SIGTRAP", afterMs: 3 * 60 * 60_000 }]);
        const outcome = superviseAgentDaemon(fixture.dependencies, POLICY);
        await expect.poll(() => fixture.spawned.length).toBe(2);

        expect(fixture.sleeps).toEqual([1_000]);
        expect(fixture.published.map((snapshot) => snapshot.phase)).toEqual([
            "running",
            "restarting",
            "running",
        ]);
        expect(fixture.published[2]).toMatchObject({
            daemonPid: fixture.spawned[1],
            restarts: 1,
            lastExit: { code: null, signal: "SIGTRAP" },
        });

        // The supervisor is told to stop: it stops watching and leaves the daemon running.
        fixture.stop.abort();
        await expect(outcome).resolves.toEqual({
            kind: "stopped",
            reason: "supervisor-stopped",
        });
        expect(fixture.released).toBe(1);
    });

    it("does not restart a daemon that exited cleanly", async () => {
        const fixture = arrange([{ code: 0, signal: null, afterMs: 5_000 }]);

        await expect(superviseAgentDaemon(fixture.dependencies, POLICY)).resolves.toEqual({
            kind: "stopped",
            reason: "clean-exit",
        });
        expect(fixture.spawned).toHaveLength(1);
        expect(fixture.sleeps).toEqual([]);
        expect(fixture.released).toBe(1);
    });

    it("does not restart a daemon killed after an intentional stop was recorded", async () => {
        // A caller that gave up waiting for an accepted shutdown, or `happy-agent kill`.
        const fixture = arrange([
            { code: null, signal: "SIGKILL", afterMs: 5_000, intended: true },
        ]);

        await expect(superviseAgentDaemon(fixture.dependencies, POLICY)).resolves.toEqual({
            kind: "stopped",
            reason: "stop-intent",
        });
        expect(fixture.spawned).toHaveLength(1);
    });

    it("backs off and gives up after repeated failures soon after starting", async () => {
        const fixture = arrange([
            { code: 1, signal: null, afterMs: 2_000 },
            { code: 1, signal: null, afterMs: 2_000 },
            { code: null, signal: "SIGABRT", afterMs: 2_000 },
        ]);

        const outcome = await superviseAgentDaemon(fixture.dependencies, POLICY);

        expect(outcome).toMatchObject({
            kind: "gave-up",
            lastExit: { code: null, signal: "SIGABRT", uptimeMs: 2_000 },
        });
        expect(fixture.spawned).toHaveLength(3);
        expect(fixture.sleeps).toEqual([1_000, 2_000]);
        expect(fixture.published.at(-1)).toMatchObject({
            phase: "gave-up",
            quickFailures: 3,
            restarts: 2,
        });
        // The record stays for status and the desktop app to read.
        expect(fixture.released).toBe(0);
    });

    it("never restarts a daemon that refused data a newer release wrote", async () => {
        const fixture = arrange([
            { code: 65, signal: null, afterMs: 1_500 },
            { code: 65, signal: null, afterMs: 1_500 },
        ]);

        const outcome = await superviseAgentDaemon(fixture.dependencies, POLICY);

        expect(outcome).toMatchObject({ kind: "refused", lastExit: { code: 65, signal: null } });
        expect(fixture.spawned).toHaveLength(1);
        expect(fixture.sleeps).toEqual([]);
        expect(fixture.published.map((snapshot) => snapshot.phase)).toEqual(["running", "refused"]);
        // The record stays for status and the desktop app to read.
        expect(fixture.released).toBe(0);
    });

    it("never restarts a daemon that found its socket already served", async () => {
        const fixture = arrange([
            { code: 69, signal: null, afterMs: 500 },
            { code: 69, signal: null, afterMs: 500 },
        ]);

        const outcome = await superviseAgentDaemon(fixture.dependencies, POLICY);

        expect(outcome).toMatchObject({
            kind: "socket-in-use",
            lastExit: { code: 69, signal: null },
        });
        expect(fixture.spawned).toHaveLength(1);
        expect(fixture.sleeps).toEqual([]);
        expect(fixture.published.map((snapshot) => snapshot.phase)).toEqual(["running"]);
        // Nothing is supervised any more; whoever serves the socket needs no record from here.
        expect(fixture.released).toBe(1);
    });

    it("treats a crash after a long healthy run as a fresh failure, not part of a loop", async () => {
        const fixture = arrange([
            { code: 1, signal: null, afterMs: 2_000 },
            { code: 1, signal: null, afterMs: 2_000 },
            { code: null, signal: "SIGSEGV", afterMs: 10 * 60_000 },
            { code: 1, signal: null, afterMs: 2_000 },
        ]);
        const outcome = superviseAgentDaemon(fixture.dependencies, POLICY);
        await expect.poll(() => fixture.spawned.length).toBe(5);

        expect(fixture.sleeps).toEqual([1_000, 2_000, 1_000, 2_000]);
        fixture.stop.abort();
        await expect(outcome).resolves.toMatchObject({ kind: "stopped" });
    });

    it("caps the backoff between restarts", async () => {
        const fixture = arrange(
            Array.from({ length: 5 }, () => ({ code: 1, signal: null, afterMs: 1_000 })),
        );

        await superviseAgentDaemon(fixture.dependencies, { ...POLICY, maxQuickFailures: 5 });

        expect(fixture.sleeps).toEqual([1_000, 2_000, 4_000, 4_000]);
    });

    it("stands down when another daemon started while this one was down", async () => {
        const fixture = arrange([{ code: null, signal: "SIGKILL", afterMs: 90_000 }], {
            otherDaemon: true,
        });

        await expect(superviseAgentDaemon(fixture.dependencies, POLICY)).resolves.toEqual({
            kind: "stopped",
            reason: "replaced",
        });
        expect(fixture.spawned).toHaveLength(1);
        expect(fixture.released).toBe(1);
    });

    it("counts a daemon that cannot be spawned as a quick failure", async () => {
        const fixture = arrange([]);
        fixture.dependencies.spawnDaemon = async () => {
            throw new Error("ENOENT");
        };

        await expect(superviseAgentDaemon(fixture.dependencies, POLICY)).resolves.toMatchObject({
            kind: "gave-up",
            lastExit: { code: null, signal: null },
        });
        expect(fixture.sleeps).toEqual([1_000, 2_000]);
    });
});
