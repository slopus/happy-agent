import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import {
    SandboxShellRunner,
    SandboxShellRunnerUnavailableError,
} from "../../sources/host/impl/SandboxShellRunner.js";
import { NativeProcessManager } from "../../sources/processes/index.js";

// Speaks the native `--shell-runner` protocol, so the daemon side can be tested without a sandbox.
const FAKE_RUNNER = String.raw`
const readline = require("node:readline");
const out = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const running = new Map();
if (process.argv.includes("--fail")) { process.stderr.write("setup failed"); process.exit(5); }
out({ type: "ready" });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    const { id } = request;
    if (request.type === "run") {
        const [program, arg] = request.argv;
        out({ type: "spawned", id, pid: 1000 + id });
        const exit = (code) => { running.delete(id); out({ type: "exit", id, code, timedOut: false }); };
        if (program === "echo") {
            out({ type: "stdout", id, data: Buffer.from(arg).toString("base64") });
            exit(0);
        } else if (program === "env") {
            out({ type: "stdout", id, data: Buffer.from(request.env[arg] ?? "").toString("base64") });
            exit(0);
        } else if (program === "cat") {
            running.set(id, { exit, input: "" });
        } else if (program === "crash") {
            process.exit(3);
        } else {
            running.set(id, { exit });
        }
    } else if (request.type === "stdin") {
        const command = running.get(id);
        if (command) command.input += Buffer.from(request.data, "base64").toString();
    } else if (request.type === "closeStdin") {
        const command = running.get(id);
        if (command) {
            out({ type: "stdout", id, data: Buffer.from(command.input).toString("base64") });
            command.exit(0);
        }
    } else if (request.type === "terminate") {
        running.get(id)?.exit(1);
    }
});
process.stdin.on("end", () => process.exit(0));
`;

describe("SandboxShellRunner", () => {
    const disposals: (() => Promise<void>)[] = [];
    afterEach(async () => {
        for (const dispose of disposals.splice(0)) await dispose();
    });

    async function fakeRunner(...flags: string[]) {
        const directory = await mkdtemp(join(tmpdir(), "happy-shell-runner-"));
        const script = join(directory, "runner.cjs");
        await writeFile(script, FAKE_RUNNER);
        const ctx = createRootContext().named("shell-runner-test");
        const runner = new SandboxShellRunner({
            args: [script, ...flags],
            command: process.execPath,
            ctx,
            environment: process.env,
            processCwd: directory,
        });
        const manager = new NativeProcessManager(ctx);
        disposals.push(async () => {
            await runner.dispose();
            await rm(directory, { force: true, recursive: true });
        });
        const start = (argv: string[], env: NodeJS.ProcessEnv = {}) =>
            manager.start(ctx, {
                command: argv.join(" "),
                cwd: directory,
                transport: () => runner.start({ argv, env, tty: false }),
            });
        return { ctx, runner, start };
    }

    it("runs commands with their own environment and reports output and exit", async () => {
        const { ctx, start } = await fakeRunner();
        const echoed = await (await start(["echo", "hello"])).wait(ctx);
        expect(echoed.stdout).toBe("hello");
        expect(echoed.exitCode).toBe(0);
        const env = await (await start(["env", "ONLY_MINE"], { ONLY_MINE: "yes" })).wait(ctx);
        expect(env.stdout).toBe("yes");
        const other = await (await start(["env", "ONLY_MINE"])).wait(ctx);
        expect(other.stdout).toBe("");
    });

    it("runs commands at once, delivers input, and stops only the one asked", async () => {
        const { ctx, runner, start } = await fakeRunner();
        const first = await start(["sleep"]);
        const second = await start(["cat"]);
        expect(runner.activeCount).toBe(2);
        await second.writeStdin(ctx, "typed");
        await second.endStdin(ctx);
        const read = await second.wait(ctx);
        expect(read.stdout).toBe("typed");
        expect(first.status).toBe("running");
        await first.kill(ctx);
        const stopped = await first.wait(ctx);
        expect(stopped.killed).toBe(true);
        expect(runner.activeCount).toBe(0);
    });

    it("ends every running command with an error when the runner dies, then starts again", async () => {
        const { ctx, start } = await fakeRunner();
        const waiting = await start(["sleep"]);
        const crashing = await start(["crash"]);
        const [lost, crashed] = await Promise.all([waiting.wait(ctx), crashing.wait(ctx)]);
        for (const result of [lost, crashed]) {
            expect(result.exitCode).toBeNull();
            expect(result.stderr).toMatch(/sandbox shell runner stopped/u);
        }
        // Refused during the backoff instead of starting a sandbox for every command.
        await expect(start(["echo", "soon"])).rejects.toBeInstanceOf(
            SandboxShellRunnerUnavailableError,
        );
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        expect((await (await start(["echo", "again"])).wait(ctx)).stdout).toBe("again");
    });

    it("reports a runner that cannot start, and refuses without retrying at once", async () => {
        const { start } = await fakeRunner("--fail");
        const failure = await start(["echo", "x"]).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(SandboxShellRunnerUnavailableError);
        expect((failure as Error).message).toMatch(/setup failed/u);
        const refused = await start(["echo", "x"]).catch((error: unknown) => error);
        expect((refused as Error).message).toMatch(/try again in about/u);
    });
});
