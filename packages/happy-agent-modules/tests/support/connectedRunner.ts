import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureAgentDatabaseConnection } from "@slopus/happy-agent-base";
import {
    createHostCompute,
    createRunnerChannelPair,
    RunnerHost,
    type Compute,
    type ComputeWatchOptions,
    type RunnerChannel,
} from "@slopus/happy-agent-compute";

import type { ConfigModule } from "../../sources/config/index.js";
import { RunnersModule } from "../../sources/runners/index.js";
import { moduleDatabase } from "./moduleDatabase.js";

const TOKEN = "a".repeat(43);

/** A watch the runner opened for the daemon, as the runner itself saw it. */
export interface RunnerWatchRecord {
    readonly options: ComputeWatchOptions;
    closed: boolean;
}

/**
 * A runners module connected to an in-process runner whose home is a temporary folder here.
 *
 * The runner serves real host computes over the unchanged runner protocol, and records every
 * watch it opens, so a test can count the streams a daemon feature costs on the runner.
 */
export async function connectedRunner(cleanups: (() => Promise<void> | void)[]) {
    const home = await realpath(await mkdtemp(join(tmpdir(), "happy-runner-")));
    cleanups.push(async () => await rm(home, { force: true, recursive: true }));
    const config = {
        get runners() {
            return { defaultId: "build-box", entries: { "build-box": { token: TOKEN } } };
        },
    } as unknown as ConfigModule;
    const runners = new RunnersModule(config);
    const database = moduleDatabase(runners.migrations, "connected-runner-test");
    ensureAgentDatabaseConnection(database.database);
    await database.ready;
    runners.beforeStart(database.context);
    cleanups.push(() => database.close());
    cleanups.push(async () => await runners.close());

    const watches: RunnerWatchRecord[] = [];
    const traffic: RunnerTraffic = { toRunner: 0, fromRunner: 0, frames: 0 };
    const root = database.rootContext;
    const startHost = () => {
        const started = new RunnerHost({
            ctx: root.named("test-runner"),
            identity: { version: "9.9.9", platform: "linux", arch: "x64", hostname: "box", home },
            createCompute: async (computeCtx, request) =>
                recordWatches(createHostCompute({ ctx: computeCtx, cwd: request.cwd }), watches),
        });
        cleanups.push(async () => await started.dispose(root.named("test-runner-dispose")));
        return started;
    };
    let host = startHost();

    const connect = async (): Promise<() => void> => {
        const connected = new Promise<void>((resolve) => {
            const stop = runners.onUpdated((_ctx, snapshot) => {
                if (snapshot.runners[0]?.status !== "connected") return;
                stop();
                resolve();
            });
        });
        const [daemonSide, runnerSide] = createRunnerChannelPair();
        void runners.accept("build-box", metered(daemonSide, traffic)).catch(() => undefined);
        void host.serve(runnerSide);
        await connected;
        // Drops the connection without a goodbye, as a network failure would.
        return () => runnerSide.close("The test cut the connection.");
    };
    const disconnect = await connect();
    /**
     * Stops the runner process and starts a new one, which holds nothing of what the old one
     * held, without connecting it yet.
     */
    const restart = async (): Promise<void> => {
        const stopped = host;
        host = startHost();
        await stopped.dispose(root.named("test-runner-restart"));
    };
    return {
        home,
        get host() {
            return host;
        },
        runners,
        runnerId: "build-box",
        traffic,
        watches,
        connect,
        disconnect,
        restart,
    };
}

/** Bytes and frames that crossed the daemon's end of the runner connection. */
export interface RunnerTraffic {
    toRunner: number;
    fromRunner: number;
    frames: number;
}

/** The daemon's end of a channel, counting what crosses it. */
function metered(channel: RunnerChannel, traffic: RunnerTraffic): RunnerChannel {
    return {
        send(frame) {
            traffic.toRunner += frame.byteLength;
            traffic.frames += 1;
            channel.send(frame);
        },
        close: (reason) => channel.close(reason),
        receive(receiver) {
            channel.receive({
                frame(frame) {
                    traffic.fromRunner += frame.byteLength;
                    traffic.frames += 1;
                    receiver.frame(frame);
                },
                close: (reason) => receiver.close(reason),
            });
        },
    };
}

/** The same compute, with every watch it opens recorded until it closes. */
function recordWatches(compute: Compute, watches: RunnerWatchRecord[]): Compute {
    const watcher = compute.watcher;
    if (watcher === undefined) return compute;
    return {
        ...compute,
        watcher: {
            async watch(ctx, options) {
                const watch = await watcher.watch(ctx, options);
                const record: RunnerWatchRecord = { options, closed: false };
                watches.push(record);
                void watch.closed.then(() => {
                    record.closed = true;
                });
                return watch;
            },
        },
    };
}
