import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import type { Compute } from "../../sources/Compute.js";
import type { ComputeSessionExit } from "../../sources/ComputeShell.js";
import { allowEverything, computePermissions } from "../../sources/ComputePermissions.js";
import { createHostCompute } from "../../sources/host/index.js";
import {
    createRunnerChannelPair,
    createRunnerCompute,
    RunnerHost,
    RunnerLink,
    type RunnerLinkOptions,
} from "../../sources/runner/index.js";

const ctx: Context = createRootContext().named("runner-compute-test");
const files = computePermissions("workspace_write");
const commands = allowEverything();
const cleanups: Array<() => Promise<void>> = [];
const windows = process.platform === "win32";
/** A command for the runner's shell: POSIX sh here, Windows PowerShell on Windows. */
const shell = (posix: string, powershell: string): string => (windows ? powershell : posix);
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const sleep = (seconds: number): string =>
    shell(`sleep ${String(seconds)}`, `[Threading.Thread]::Sleep(${String(seconds * 1_000)})`);
/** Prints the shell's process ID on its own line, then sleeps until killed. */
const pidThenSleep = shell(
    "echo $$; exec sleep 30",
    "[Console]::WriteLine($PID); [Threading.Thread]::Sleep(30000)",
);

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("a compute on a runner", () => {
    it("reads and writes files on the runner's machine", async () => {
        const { compute, folder } = await runnerCompute();

        await compute.fs.mkdir(files, "notes", { recursive: true });
        await compute.fs.writeFile(files, "notes/hello.txt", "héllo");
        await compute.fs.writeFile(files, "notes/bytes.bin", new Uint8Array([0, 1, 2, 255]));

        expect(compute.cwd).toBe(folder);
        await expect(compute.fs.readFile(files, "notes/hello.txt")).resolves.toBe("héllo");
        await expect(compute.fs.readFileBuffer(files, "notes/bytes.bin")).resolves.toEqual(
            new Uint8Array([0, 1, 2, 255]),
        );
        await expect(compute.fs.stat(files, "notes/hello.txt")).resolves.toMatchObject({
            isFile: true,
            size: 6,
        });
        await expect(
            compute.fs.lstatMany(files, ["notes/hello.txt", "notes/missing.txt"]),
        ).resolves.toEqual([expect.objectContaining({ isFile: true }), undefined]);
        await expect(compute.fs.readdirPage(files, "notes", { limit: 1 })).resolves.toEqual({
            entries: ["bytes.bin"],
            hasMore: true,
        });
        await compute.fs.move(files, "notes/hello.txt", "notes/moved.txt");
        await expect(compute.fs.exists(files, "notes/hello.txt")).resolves.toBe(false);
        await compute.fs.rm(files, "notes", { recursive: true });
        await expect(compute.fs.exists(files, "notes")).resolves.toBe(false);
    });

    it("gives one command its own environment on the runner, and reports it as secret", async () => {
        const { compute } = await runnerCompute();
        process.env["HAPPY_RUNNER_HIDDEN"] = "visible";
        cleanups.push(async () => {
            delete process.env["HAPPY_RUNNER_HIDDEN"];
        });
        const print = shell(
            'printf "%s|%s" "$HAPPY_RUNNER_SECRET" "$HAPPY_RUNNER_HIDDEN"',
            '[Console]::Write("$env:HAPPY_RUNNER_SECRET|$env:HAPPY_RUNNER_HIDDEN")',
        );
        const environment = { HAPPY_RUNNER_SECRET: "value", HAPPY_RUNNER_HIDDEN: null };

        await expect(
            compute.shell.run({ command: print, permissions: commands, environment }),
        ).resolves.toMatchObject({ stdout: "value|", exitCode: 0 });
        await expect(
            compute.shell.run({ command: print, permissions: commands }),
        ).resolves.toMatchObject({ stdout: "|visible", exitCode: 0 });

        const sessionId = await compute.shell.startSession({
            command: print,
            permissions: commands,
            environment,
        });
        expect(compute.shell.sessionUsesSecrets?.(sessionId)).toBe(true);
        let output = "";
        for (let attempt = 0; attempt < 200 && output !== "value|"; attempt++) {
            output += (await compute.shell.readSession(sessionId, { waitMs: 50 }))?.stdout ?? "";
        }
        expect(output).toBe("value|");
    });

    it("listens on the runner's loopback at the port asked for, for its own user", async () => {
        const { compute } = await runnerCompute();
        const probe = await compute.network!.listen!(ctx);
        const port = probe.port;
        probe.close();
        await probe.closed;

        const listener = await compute.network!.listen!(ctx, { port, ownerOnly: true });
        cleanups.push(async () => listener.close());
        expect(listener.port).toBe(port);
        await expect(compute.network!.listen!(ctx, { port })).rejects.toMatchObject({
            code: "EADDRINUSE",
        });
        listener.onConnection((socket) => {
            socket.on("error", () => undefined);
            socket.resume();
            socket.end("from the runner");
        });

        const reply = await new Promise<string>((resolve, reject) => {
            let text = "";
            const socket = connectTcp({ host: "127.0.0.1", port });
            socket.setEncoding("utf8");
            socket.on("data", (chunk: string) => {
                text += chunk;
            });
            socket.once("end", () => resolve(text));
            socket.once("error", reject);
        });
        expect(reply).toBe("from the runner");
    });

    it("keeps Node-style error codes so callers can branch on them", async () => {
        const { compute } = await runnerCompute();

        await expect(compute.fs.readFile(files, "missing.txt")).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("runs commands and reads background sessions as deltas", async () => {
        const { compute } = await runnerCompute();

        await expect(
            compute.shell.run({
                command: shell("printf runner", "[Console]::Write('runner')"),
                permissions: commands,
            }),
        ).resolves.toMatchObject({ stdout: "runner", exitCode: 0, timedOut: false });

        const echo = shell(
            "cat",
            `& ${quote(process.execPath)} -e 'process.stdin.pipe(process.stdout)'`,
        );
        const sessionId = await compute.shell.startSession({
            command: echo,
            permissions: commands,
        });
        await waitFor(() => compute.shell.activeSessionCount?.() === 1);
        expect(compute.shell.activeSessions?.()).toEqual([
            expect.objectContaining({ command: echo, sessionId, status: "running" }),
        ]);

        await expect(compute.shell.writeSession(commands, sessionId, "ping\n")).resolves.toBe(true);
        await waitFor(async () => {
            const snapshot = await compute.shell.readSession(sessionId, { peek: true });
            return snapshot?.stdout.includes("ping") === true;
        });
        const first = await compute.shell.readSession(sessionId);
        expect(first?.stdoutDelta).toContain("ping");
        const second = await compute.shell.readSession(sessionId);
        expect(second?.stdoutDelta).toBe("");

        await expect(compute.shell.killSession(sessionId)).resolves.toMatchObject({
            sessionId,
            status: "killed",
        });
        await waitFor(() => compute.shell.activeSessionCount?.() === 0);
    });

    it("tells the daemon when a background command exits on its own", async () => {
        const { compute } = await runnerCompute();
        const exits: ComputeSessionExit[] = [];
        compute.shell.setSessionExitListener?.((exit) => {
            exits.push(exit);
        });

        const sessionId = await compute.shell.startSession({
            command: shell("sleep 0.1; exit 3", "[Threading.Thread]::Sleep(100); exit 3"),
            permissions: commands,
        });

        await waitFor(() => exits.length === 1);
        expect(exits[0]).toMatchObject({ sessionId, status: "completed", exitCode: 3 });
    });

    it("refuses attached secrets instead of running without them", async () => {
        const { compute } = await runnerCompute();

        await expect(
            compute.shell.run({
                command: shell("true", "exit 0"),
                permissions: commands,
                secrets: ["github"],
            }),
        ).rejects.toThrow("Attached secrets are not available to commands on a runner yet.");
    });
});

describe("the runner connection", () => {
    it("keeps commands running across a reconnect within the lease", async () => {
        const runner = await runnerCompute();
        const sessionId = await runner.compute.shell.startSession({
            command: sleep(30),
            permissions: commands,
        });
        await waitFor(() => runner.compute.shell.activeSessionCount?.() === 1);

        runner.drop();
        await waitFor(() => runner.link.status().state === "disconnected");
        await connect(runner.host, runner.link);

        await expect(
            runner.compute.shell.readSession(sessionId, { peek: true }),
        ).resolves.toMatchObject({
            sessionId,
            status: "running",
        });
        expect(runner.host.computeCount()).toBe(1);
    });

    it("kills everything when the daemon stays away longer than its lease", async () => {
        const runner = await runnerCompute({ leaseGraceMs: 50 });
        const exits: ComputeSessionExit[] = [];
        runner.compute.shell.setSessionExitListener?.((exit) => {
            exits.push(exit);
        });
        const lostSession = await runner.compute.shell.startSession({
            command: pidThenSleep,
            permissions: commands,
        });
        const pid = await processId(runner.compute, lostSession);

        runner.drop();
        await waitFor(() => runner.host.computeCount() === 0);
        await waitFor(() => !isRunning(pid));

        await connect(runner.host, runner.link);
        await waitFor(() => exits.length === 1);
        expect(exits[0]).toMatchObject({ sessionId: lostSession, status: "killed" });
        await expect(runner.compute.shell.readSession(lostSession)).resolves.toBeUndefined();

        const nextSession = await runner.compute.shell.startSession({
            command: sleep(30),
            permissions: commands,
        });
        expect(nextSession).toBeGreaterThan(lostSession);
        await expect(runner.compute.fs.exists(files, ".")).resolves.toBe(true);
    });

    it("releases a previous daemon process as soon as a new one connects", async () => {
        const runner = await runnerCompute();
        const sessionId = await runner.compute.shell.startSession({
            command: pidThenSleep,
            permissions: commands,
        });
        const pid = await processId(runner.compute, sessionId);

        const restarted = link({ instanceId: "second-daemon-process" });
        runner.drop();
        await connect(runner.host, restarted);

        await waitFor(() => !isRunning(pid));
        expect(runner.host.computeCount()).toBe(0);
    });

    it("releases everything at once when the daemon says goodbye", async () => {
        const runner = await runnerCompute({ leaseGraceMs: 60_000 });
        const sessionId = await runner.compute.shell.startSession({
            command: pidThenSleep,
            permissions: commands,
        });
        const pid = await processId(runner.compute, sessionId);

        runner.link.close("The runner was removed.");

        await waitFor(() => runner.host.computeCount() === 0);
        await waitFor(() => !isRunning(pid));
        expect(runner.link.status().state).toBe("closed");
    });

    it("reports an unknown outcome instead of replaying work cut off by a dropped link", async () => {
        const runner = await runnerCompute();
        const running = runner.compute.shell.run({ command: sleep(5), permissions: commands });
        await delay(50);

        runner.drop();

        await expect(running).rejects.toMatchObject({ code: "ERUNNERDISCONNECTED" });
    });

    it("fails plainly when the runner is not connected", async () => {
        const unconnected = link();

        await expect(
            createRunnerCompute(ctx, {
                link: unconnected,
                computeId: "agent-1",
                cwd: "/work",
                reconnectWaitMs: 0,
            }),
        ).rejects.toMatchObject({
            code: "ERUNNERUNAVAILABLE",
            message: "The runner Build box is not connected.",
        });
    });

    it("bridges a brief drop but stops waiting once the runner has been away too long", async () => {
        const runner = await runnerCompute({}, { reconnectWaitMs: 1_000 });
        runner.drop();
        await waitFor(() => runner.link.status().state === "disconnected");

        const bridged = runner.compute.fs.exists(files, ".");
        await delay(50);
        const reconnected = await connect(runner.host, runner.link);
        await expect(bridged).resolves.toBe(true);

        reconnected.runnerEnd.close("The network dropped again.");
        await waitFor(() => runner.link.status().state === "disconnected");
        await delay(1_100);
        const startedAt = Date.now();
        await expect(runner.compute.fs.exists(files, ".")).rejects.toMatchObject({
            code: "ERUNNERUNAVAILABLE",
        });
        expect(Date.now() - startedAt).toBeLessThan(500);
    });

    it("cancels a long read on the runner when the caller stops waiting", async () => {
        const { compute } = await runnerCompute();
        const sessionId = await compute.shell.startSession({
            command: sleep(30),
            permissions: commands,
        });
        const controller = new AbortController();

        const reading = compute.shell.readSession(sessionId, {
            waitMs: 20_000,
            signal: controller.signal,
        });
        await delay(50);
        controller.abort(new Error("The agent stopped waiting."));

        await expect(reading).rejects.toThrow("The agent stopped waiting.");
        await expect(compute.shell.readSession(sessionId, { peek: true })).resolves.toMatchObject({
            status: "running",
        });
    });
});

async function runnerCompute(
    options: Partial<RunnerLinkOptions> = {},
    compute: { readonly reconnectWaitMs?: number } = {},
) {
    const folder = await mkdtemp(join(tmpdir(), "runner-compute-"));
    // Windows releases a killed shell's hold on its working folder a moment after it exits.
    cleanups.push(async () =>
        rm(folder, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 }),
    );
    const host = new RunnerHost({
        ctx,
        identity: {
            version: "test",
            platform: process.platform,
            arch: process.arch,
            hostname: "test",
            home: folder,
        },
        createCompute: async (computeCtx, request) =>
            createHostCompute({ ctx: computeCtx, cwd: request.cwd }),
    });
    cleanups.push(async () => host.dispose(ctx));
    const daemon = link(options);
    const connection = await connect(host, daemon);
    const created = await createRunnerCompute(ctx, {
        link: daemon,
        computeId: "agent-1",
        cwd: folder,
        ...compute,
    });
    cleanups.push(async () => created.dispose(ctx));
    return {
        compute: created,
        folder,
        host,
        link: daemon,
        /** Lose the connection without either side saying goodbye. */
        drop: () => connection.runnerEnd.close("The network dropped."),
    };
}

function link(options: Partial<RunnerLinkOptions> = {}): RunnerLink {
    const created = new RunnerLink(ctx, {
        name: "Build box",
        instanceId: "first-daemon-process",
        ...options,
    });
    cleanups.push(async () => created.close("The test finished."));
    return created;
}

async function connect(host: RunnerHost, daemon: RunnerLink) {
    const [daemonEnd, runnerEnd] = createRunnerChannelPair();
    const served = host.serve(runnerEnd);
    await daemon.accept(daemonEnd);
    return { daemonEnd, runnerEnd, served };
}

async function processId(compute: Compute, sessionId: number): Promise<number> {
    let output = "";
    await waitFor(async () => {
        output += (await compute.shell.readSession(sessionId))?.stdoutDelta ?? "";
        return /\d+\r?\n/.test(output);
    });
    return Number.parseInt(output, 10);
}

/** Alive and not a zombie: a sandbox whose init does not reap leaves killed orphans as zombies. */
function isRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
    } catch {
        return false;
    }
    try {
        return readFileSync(`/proc/${String(pid)}/stat`, "utf8").split(" ")[2] !== "Z";
    } catch {
        return true;
    }
}

/** Windows PowerShell takes far longer to start than sh, so Windows waits longer. */
async function waitFor(
    check: () => boolean | Promise<boolean>,
    timeoutMs = windows ? 10_000 : 4_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error("The expected state never arrived.");
        await delay(10);
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
