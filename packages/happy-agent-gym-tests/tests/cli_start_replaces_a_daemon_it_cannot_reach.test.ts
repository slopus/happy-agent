import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createGymHome, type GymHome } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

/**
 * A daemon still serves the socket after its token and PID files are gone, as happens after an
 * uninstall and reinstall: it rejects every client and nothing can reach it through the API.
 * `start` must stop it and start its own instead of failing on the busy socket, and must leave a
 * listener that is not Happy Agent running and fail at once, without writing a token beside it.
 *
 * The real CLI, crash supervisor, and daemon run as separate processes in a throwaway Happy home.
 * The executable is `HAPPY_AGENT_RELOAD_GYM_BINARY` when set, else the locally compiled binary
 * (`pnpm --filter @slopus/happy-agent build:bun`) when present, else the built CLI on the gym's
 * runtime.
 */
const PACKAGE = resolve(import.meta.dirname, "../../happy-agent");
const COMPILED = join(PACKAGE, "dist", "bin", `happy-agent-${process.platform}-${process.arch}`);
const COMMAND: readonly string[] =
    process.env.HAPPY_AGENT_RELOAD_GYM_BINARY !== undefined
        ? [resolve(process.env.HAPPY_AGENT_RELOAD_GYM_BINARY)]
        : existsSync(COMPILED)
          ? [COMPILED]
          : [process.execPath, join(PACKAGE, "dist", "cli.js")];

/** `EX_UNAVAILABLE`: another process serves the daemon socket. */
const SOCKET_IN_USE_EXIT_CODE = 69;

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
}, 60_000);

describe.skipIf(process.platform === "win32")("happy-agent start on a socket it cannot use", () => {
    it("stops a Happy Agent whose token and PID files are gone, then starts its own", async () => {
        const world = await installation();
        expect((await world.cli(["start"])).code).toBe(0);
        const stranded = await world.daemonPid();
        const strandedSupervisor = await world.supervisorPid();
        await rm(world.tokenPath);
        await rm(world.pidPath);

        const started = await world.cli(["start"]);

        expect(started.code).toBe(0);
        expect(started.output).toContain(
            `(PID ${String(stranded)}), which this installation could no longer reach.`,
        );
        expect(isRunning(stranded)).toBe(false);
        // Its crash supervisor stood down instead of restarting it over the new daemon.
        expect(isRunning(strandedSupervisor)).toBe(false);
        expect(await world.daemonPid()).not.toBe(stranded);
        expect((await world.cli(["status"])).output).toContain("Daemon is running at");
        const log = await readFile(world.logPath, "utf8");
        expect(log).toContain(`start: Stopped Happy Agent`);
    }, 120_000);

    it("stops a Happy Agent that rejects the token on disk", async () => {
        const world = await installation();
        expect((await world.cli(["start"])).code).toBe(0);
        const stranded = await world.daemonPid();
        // A failed start wrote a fresh token the running daemon never knew.
        await writeFile(world.tokenPath, `${randomBytes(32).toString("base64url")}\n`, {
            mode: 0o600,
        });
        await rm(world.pidPath);

        const started = await world.cli(["start"]);

        expect(started.code).toBe(0);
        expect(started.output).toContain(`(PID ${String(stranded)})`);
        expect(isRunning(stranded)).toBe(false);
        expect((await world.cli(["status"])).output).toContain("Daemon is running at");
    }, 120_000);

    it("leaves a listener that is not Happy Agent running and fails at once", async () => {
        const world = await installation();
        await mkdir(world.agentDirectory, { recursive: true, mode: 0o700 });
        const foreign = await listenOn(world.socketPath);
        cleanups.push(async () => {
            foreign.kill("SIGKILL");
        });

        const begun = Date.now();
        const refused = await world.cli(["start"]);

        expect(refused.code).toBe(SOCKET_IN_USE_EXIT_CODE);
        expect(refused.output).toContain(`Process ${String(foreign.pid)} (`);
        expect(refused.output).toContain(
            `is serving ${world.socketPath}, and it is not Happy Agent.`,
        );
        // No crash-supervisor backoff, and no token beside a daemon that never knew it.
        expect(Date.now() - begun).toBeLessThan(10_000);
        expect(existsSync(world.tokenPath)).toBe(false);
        expect(isRunning(foreign.pid!)).toBe(true);
    }, 120_000);
});

/** A process that is not Happy Agent, listening on the daemon socket. */
async function listenOn(socketPath: string): Promise<ChildProcess> {
    const child = spawn(
        process.execPath,
        [
            "-e",
            `require("node:net").createServer((socket) => socket.end()).listen(${JSON.stringify(socketPath)}, () => console.log("listening"))`,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((done, fail) => {
        child.stdout!.once("data", () => done());
        child.once("exit", (code) => fail(new Error(`The listener exited with ${String(code)}.`)));
    });
    return child;
}

function isRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** One isolated installation with the CLI pointed at it. */
async function installation() {
    const home = await createGymHome();
    cleanups.push(async () => await home.remove());
    await mkdir(join(home.root, "home"));
    await mkdir(join(home.root, "claude"));
    await writeFile(
        join(
            home.publicHomePath,
            process.platform === "darwin" ? "Config" : "config",
            "happy.toml",
        ),
        [
            "[providers]",
            "default_enable = false",
            "",
            "[providers.claude]",
            "enabled = true",
            `config_dir = ${JSON.stringify(join(home.root, "claude"))}`,
            'include_models = ["anthropic/opus-5"]',
            "",
        ].join("\n"),
    );
    const environment = isolatedEnvironment(home);
    const cli = (args: readonly string[]) => runCli(args, environment);
    // Stop exactly this home's daemon, whatever state a failed scenario left it in.
    cleanups.push(async () => {
        await cli(["kill"]);
    });
    const agentDirectory = join(home.happyHome, "agent");
    const pidPath = join(agentDirectory, "daemon.pid");
    return {
        agentDirectory,
        cli,
        daemonPid: async () => Number((await readFile(pidPath, "utf8")).trim()),
        home,
        logPath: join(agentDirectory, "daemon.log"),
        pidPath,
        socketPath: join(agentDirectory, "server.sock"),
        supervisorPid: async () =>
            (
                JSON.parse(await readFile(join(agentDirectory, "supervisor.json"), "utf8")) as {
                    supervisorPid: number;
                }
            ).supervisorPid,
        tokenPath: join(agentDirectory, "token"),
    };
}

function isolatedEnvironment(home: GymHome): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
        // Nothing that names another installation or a real account reaches the CLI.
        if (/^(HAPPY_|ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|XAI_|GROK_)/u.test(key)) continue;
        environment[key] = value;
    }
    return {
        ...environment,
        GIT_CEILING_DIRECTORIES: resolve(home.root, "..", ".."),
        HAPPY_AGENT_PROJECTS_DIRECTORY: join(home.root, "projects"),
        HAPPY_AGENT_WORKSPACES_DIRECTORY: join(home.root, "workspaces"),
        // Nothing here runs inference; the seam only keeps real accounts out of reach.
        HAPPY_GYM_INFERENCE_URL: "http://127.0.0.1:9/unused",
        HAPPY_GYM_TOKEN: "unused",
        HAPPY_HOME_DIR: home.happyHome,
        HOME: join(home.root, "home"),
    };
}

function runCli(
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
): Promise<{ readonly code: number | null; readonly output: string }> {
    const home = environment.HAPPY_HOME_DIR;
    if (home === undefined || home === resolve(process.env.HOME ?? "", ".happy")) {
        throw new Error("This gym only runs the CLI against its own throwaway home.");
    }
    return new Promise((done, fail) => {
        const [executable, ...prefix] = COMMAND;
        const child = spawn(executable!, [...prefix, ...args], {
            cwd: environment.HOME,
            env: environment,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
        child.once("error", fail);
        child.once("exit", (code) => done({ code, output }));
    });
}
