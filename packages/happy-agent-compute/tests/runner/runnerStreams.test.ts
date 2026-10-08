import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duplexPair, type Duplex } from "node:stream";

import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import type { Compute } from "../../sources/Compute.js";
import type { ComputeProcess } from "../../sources/ComputeProcesses.js";
import type { ComputeWatchBatch } from "../../sources/ComputeWatcher.js";
import { createHostCompute } from "../../sources/host/index.js";
import {
    createRunnerChannelPair,
    createRunnerCompute,
    RunnerHost,
    RunnerLink,
    type RunnerChannel,
    type RunnerComputeRequest,
    type RunnerLinkOptions,
} from "../../sources/runner/index.js";

const ctx: Context = createRootContext().named("runner-streams-test");
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// The runner side runs POSIX programs here; the protocol itself is platform-neutral.
describe.runIf(process.platform !== "win32")("programs on a runner", () => {
    it("runs Git with argv and environment changes in the runner's folder", async () => {
        const { compute } = await runner();
        const processes = compute.processes!;

        const init = await collect(
            await processes.start(ctx, { command: "git", args: ["init", "-q"] }),
        );
        const status = await collect(
            await processes.start(ctx, {
                command: "git",
                args: ["status", "--porcelain=v2", "--branch"],
                environment: { GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
            }),
        );

        expect(init.exit).toEqual({ exitCode: 0, signal: null });
        expect(status.exit).toEqual({ exitCode: 0, signal: null });
        expect(status.stdout).toContain("# branch.oid (initial)");
    });

    it("reports a program that does not exist with its error code", async () => {
        const { compute } = await runner();

        await expect(
            compute.processes!.start(ctx, { command: "happy-definitely-missing-program" }),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });

    // Terminals are Bun's, the runtime Happy Agent ships on: `pnpm test:bun` proves this one.
    it.runIf("bun" in process.versions)("runs a terminal and resizes it", async () => {
        const { compute } = await runner();
        const terminal = await compute.processes!.start(ctx, {
            command: "sh",
            args: ["-c", "stty size; read line; stty size"],
            terminal: { cols: 90, rows: 20 },
        });
        let screen = "";
        terminal.onStdout((chunk) => {
            screen += Buffer.from(chunk).toString();
        });
        await waitFor(() => screen.includes("20 90"));

        terminal.resize(132, 43);
        await delay(50);
        await terminal.write("\n");

        await expect(terminal.exited).resolves.toEqual({ exitCode: 0, signal: null });
        expect(screen).toContain("43 132");
    });

    it("moves large input and output through the window without loss", async () => {
        const { compute } = await runner();
        const input = Buffer.alloc(2 * 1024 * 1024);
        for (let index = 0; index < input.length; index++) input[index] = (index * 31) % 251;
        const cat = await compute.processes!.start(ctx, { command: "cat" });
        const output = collect(cat);

        await cat.write(input);
        cat.endInput();

        const { bytes, exit } = await output;
        expect(exit).toEqual({ exitCode: 0, signal: null });
        expect(digest(bytes)).toBe(digest(input));
    });

    it("loses and repeats nothing when the link is cut while output is in flight", async () => {
        const runnerSide = await runner();
        const expected = Array.from(
            { length: 200_000 },
            (_, index) => `${String(index + 1)}\n`,
        ).join("");
        const seq = await runnerSide.compute.processes!.start(ctx, {
            command: "seq",
            args: ["1", "200000"],
        });
        const chunks: Buffer[] = [];
        seq.onStdout((chunk) => {
            chunks.push(Buffer.from(chunk));
            if (chunks.length === 3) seq.pause();
        });
        await waitFor(() => chunks.length >= 3);

        runnerSide.cut();
        await waitFor(() => runnerSide.link.status().state === "disconnected");
        await runnerSide.reconnect();
        seq.resume();

        await expect(seq.exited).resolves.toEqual({ exitCode: 0, signal: null });
        expect(Buffer.concat(chunks).toString()).toBe(expected);
    });

    it("recovers output the network dropped while it was flowing", async () => {
        const runnerSide = await runner();
        const expected = Array.from(
            { length: 200_000 },
            (_, index) => `${String(index + 1)}\n`,
        ).join("");
        const seq = await runnerSide.compute.processes!.start(ctx, {
            command: "seq",
            args: ["1", "200000"],
        });
        const chunks: Buffer[] = [];
        let reconnecting: Promise<void> | undefined;
        seq.onStdout((chunk) => {
            chunks.push(Buffer.from(chunk));
            if (chunks.length === 3) {
                runnerSide.cut();
                reconnecting = waitFor(
                    () => runnerSide.link.status().state === "disconnected",
                ).then(() => runnerSide.reconnect());
            }
        });

        await waitFor(() => reconnecting !== undefined);
        await reconnecting;

        await expect(seq.exited).resolves.toEqual({ exitCode: 0, signal: null });
        expect(runnerSide.lostFrames()).toBeGreaterThan(0);
        expect(Buffer.concat(chunks).toString()).toBe(expected);
    });

    it("keeps a terminal across a reconnect within the lease", async () => {
        const runnerSide = await runner();
        const shell = await runnerSide.compute.processes!.start(ctx, {
            command: "sh",
            args: ["-c", "while read line; do echo got:$line; done"],
        });
        let output = "";
        shell.onStdout((chunk) => {
            output += Buffer.from(chunk).toString();
        });

        runnerSide.cut();
        await waitFor(() => runnerSide.link.status().state === "disconnected");
        const typed = shell.write("after\n");
        await runnerSide.reconnect();
        await typed;

        await waitFor(() => output.includes("got:after"));
        shell.signal("SIGTERM");
        await expect(shell.exited).resolves.toMatchObject({ signal: "SIGTERM" });
    });

    it("reports programs as killed when the runner released this daemon", async () => {
        const runnerSide = await runner({ leaseGraceMs: 50 });
        const sleeper = await runnerSide.compute.processes!.start(ctx, {
            command: "sleep",
            args: ["30"],
        });

        runnerSide.cut();
        await waitFor(() => runnerSide.host.computeCount() === 0);
        await runnerSide.reconnect();

        await expect(sleeper.exited).resolves.toEqual({ exitCode: null, signal: "SIGKILL" });
    });
});

describe.runIf(process.platform === "linux")("watching on a runner", () => {
    it("reports changes, skips ignored directories, and keeps watching across a reconnect", async () => {
        const runnerSide = await runner();
        await mkdir(join(runnerSide.folder, "node_modules"), { recursive: true });
        const watch = await runnerSide.compute.watcher!.watch(ctx, {
            path: ".",
            ignore: ["node_modules"],
        });
        const batches: ComputeWatchBatch[] = [];
        watch.onChange((batch) => batches.push(batch));
        const changed = () => new Set(batches.flatMap((batch) => batch.paths));

        await writeFile(join(runnerSide.folder, "node_modules", "skipped.js"), "x");
        await writeFile(join(runnerSide.folder, "first.txt"), "x");
        await waitFor(() => changed().has("first.txt"));

        runnerSide.cut();
        await waitFor(() => runnerSide.link.status().state === "disconnected");
        await writeFile(join(runnerSide.folder, "while-away.txt"), "x");
        await runnerSide.reconnect();

        await waitFor(() => changed().has("while-away.txt"));
        expect([...changed()].some((path) => path.startsWith("node_modules"))).toBe(false);
        watch.close();
        await expect(watch.closed).resolves.toEqual({});
    });
});

describe.runIf(process.platform !== "win32")("machines in containers on a runner", () => {
    it("asks the runner for the image and refuses to reuse the machine with another", async () => {
        const { link, folder, requests } = await runner();

        const docker = await createRunnerCompute(ctx, {
            link,
            computeId: "agent-docker",
            cwd: folder,
            docker: { image: "ghcr.io/acme/dev:latest" },
        });
        cleanups.push(async () => docker.dispose(ctx));

        expect(requests.at(-1)).toEqual({
            cwd: folder,
            policy: {},
            docker: { image: "ghcr.io/acme/dev:latest" },
        });
        await expect(
            createRunnerCompute(ctx, {
                link,
                computeId: "agent-docker",
                cwd: folder,
                docker: { image: "ghcr.io/acme/other:latest" },
            }),
        ).rejects.toMatchObject({ code: "EEXIST" });
    });
});

describe.runIf(process.platform !== "win32")("connections from a runner", () => {
    it("carries bytes both ways and ends cleanly", async () => {
        const { compute } = await runner({}, { echo: true });

        const socket = await compute.network!.connect(ctx, { host: "localhost", port: 3000 });
        const reply = readAll(socket);
        socket.write("hello from the daemon");
        socket.end();

        await expect(reply).resolves.toBe("HELLO FROM THE DAEMON");
    });

    it("brings connections the runner accepts back to the daemon", async () => {
        const { compute, dial } = await runner({}, { echo: true });

        const listener = await compute.network!.listen!(ctx);
        expect(listener.port).toBe(4242);
        // Held until someone listens on this side, then answered in capitals here.
        const early = readAll(dial("early"));
        listener.onConnection((socket) => {
            socket.on("data", (chunk: Buffer) => socket.write(chunk.toString().toUpperCase()));
            socket.on("end", () => socket.end());
        });

        await expect(early).resolves.toBe("EARLY");
        await expect(readAll(dial("git fetch"))).resolves.toBe("GIT FETCH");

        listener.close();
        await expect(listener.closed).resolves.toBeUndefined();
    });
});

/** A link and a runner, joined by a channel that can be cut with frames still in flight. */
async function runner(options: Partial<RunnerLinkOptions> = {}, extra: { echo?: boolean } = {}) {
    const folder = await mkdtemp(join(tmpdir(), "runner-streams-"));
    const accepting: Array<(socket: Duplex) => void> = [];
    const requests: RunnerComputeRequest[] = [];
    cleanups.push(async () => rm(folder, { force: true, recursive: true }));
    const host = new RunnerHost({
        ctx,
        identity: {
            version: "test",
            platform: process.platform,
            arch: process.arch,
            hostname: "test",
            home: folder,
        },
        createCompute: async (computeCtx, request) => {
            requests.push(request);
            const compute = createHostCompute({ ctx: computeCtx, cwd: request.cwd });
            return extra.echo === true ? withEchoNetwork(compute, accepting) : compute;
        },
    });
    cleanups.push(async () => host.dispose(ctx));
    const link = new RunnerLink(ctx, {
        name: "Build box",
        instanceId: "daemon-process",
        ...options,
    });
    cleanups.push(() => link.close("The test finished."));
    const lost = { frames: 0 };
    let connection = await connect(host, link, lost);
    /** Open a connection to the runner-side listener as a local program would, and send `text`. */
    const dial = (text: string): Duplex => {
        const accept = accepting.at(-1);
        if (accept === undefined) throw new Error("Nothing is listening on the runner.");
        const [program, server] = duplexPair();
        accept(server);
        program.end(text);
        return program;
    };
    const compute = await createRunnerCompute(ctx, { link, computeId: "agent-1", cwd: folder });
    cleanups.push(async () => compute.dispose(ctx));
    return {
        compute,
        dial,
        folder,
        host,
        link,
        /** Drop the link; frames the runner sends from now on are lost, as on a real network. */
        cut: () => connection.cut(),
        lostFrames: () => lost.frames,
        requests,
        reconnect: async () => {
            connection = await connect(host, link, lost);
        },
    };
}

async function connect(host: RunnerHost, link: RunnerLink, lost = { frames: 0 }) {
    const [daemonEnd, runnerEnd] = createRunnerChannelPair();
    let cut = false;
    /** After a cut, frames still travelling in either direction are lost rather than delivered. */
    const lossy = (end: RunnerChannel): RunnerChannel => ({
        send: (frame) => {
            if (cut) lost.frames += 1;
            else end.send(frame);
        },
        close: (reason) => end.close(reason),
        receive: (receiver) =>
            end.receive({
                frame: (frame) => {
                    if (cut) lost.frames += 1;
                    else receiver.frame(frame);
                },
                close: (reason) => receiver.close(reason),
            }),
    });
    void host.serve(lossy(runnerEnd));
    await link.accept(lossy(daemonEnd));
    return {
        cut() {
            cut = true;
            daemonEnd.close("The network dropped.");
        },
    };
}

/**
 * A compute whose network reaches an in-memory server that answers in capitals, and whose
 * listeners take connections from `accepting` instead of a real port.
 */
function withEchoNetwork(compute: Compute, accepting: Array<(socket: Duplex) => void>): Compute {
    return {
        ...compute,
        network: {
            async connect() {
                const [client, server] = duplexPair();
                server.on("data", (chunk: Buffer) => server.write(chunk.toString().toUpperCase()));
                server.on("end", () => server.end());
                return client;
            },
            async listen() {
                let handler: ((socket: Duplex) => void) | undefined;
                let resolveClosed!: () => void;
                const closed = new Promise<void>((resolve) => {
                    resolveClosed = resolve;
                });
                accepting.push((socket) => handler?.(socket));
                return {
                    port: 4242,
                    onConnection(next) {
                        handler = next;
                        return () => undefined;
                    },
                    close: () => resolveClosed(),
                    closed,
                };
            },
        },
    };
}

async function collect(started: ComputeProcess) {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    started.onStdout((chunk) => stdout.push(Buffer.from(chunk)));
    started.onStderr((chunk) => stderr.push(Buffer.from(chunk)));
    const exit = await started.exited;
    const bytes = Buffer.concat(stdout);
    return { bytes, stdout: bytes.toString(), stderr: Buffer.concat(stderr).toString(), exit };
}

function readAll(socket: Duplex): Promise<string> {
    return new Promise((resolve, reject) => {
        let text = "";
        socket.on("data", (chunk: Buffer) => {
            text += chunk.toString();
        });
        socket.on("end", () => resolve(text));
        socket.on("error", reject);
    });
}

function digest(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("The expected state never arrived.");
        await delay(10);
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
