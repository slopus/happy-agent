import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

/** What a gym runner needs to dial its daemon. */
export interface GymRunnerOptions {
    /** The token written for this runner under `[runners.<id>]` in the gym's configuration. */
    readonly token: string;
    /** The runner's home, where the daemon places its home project and bot folders. */
    readonly home: string;
    /** Log the runner's debug lines as well, for a scenario being diagnosed. */
    readonly debug?: boolean;
}

/**
 * One real `happy-agent runner` process dialing a gym's daemon over its Unix socket.
 *
 * Unlike the agent's emulated machine, a runner is the product's own process on this computer: it
 * serves real files, real Git and real processes from its home, because that is what a runner is.
 * A scenario places folders inside the gym's directory on it, so nothing outside that directory is
 * touched.
 */
export class GymRunner {
    readonly home: string;
    readonly #process: ChildProcess;
    readonly #exited: Promise<void>;
    #output = "";

    private constructor(home: string, child: ChildProcess) {
        this.home = home;
        this.#process = child;
        this.#exited = new Promise((resolve) => child.once("exit", () => resolve()));
        child.stdout?.on("data", (chunk: Buffer) => this.#record(chunk));
        child.stderr?.on("data", (chunk: Buffer) => this.#record(chunk));
    }

    /** Start a runner against the daemon listening on `socketPath`. */
    static async start(socketPath: string, options: GymRunnerOptions): Promise<GymRunner> {
        await mkdir(options.home, { recursive: true });
        const cli = createRequire(import.meta.url).resolve("@slopus/happy-agent/cli");
        const child = spawn(
            process.execPath,
            [cli, "runner", "--endpoint", `unix:${socketPath}`, "--home", options.home],
            {
                env: {
                    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
                    // The runner's own state directory lives under its HOME, inside the gym.
                    HOME: options.home,
                    HAPPY_RUNNER_TOKEN: options.token,
                    ...(options.debug === true ? { HAPPY_RUNNER_DEBUG: "1" } : {}),
                },
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
        return new GymRunner(options.home, child);
    }

    /** Everything the runner logged so far. */
    get output(): string {
        return this.#output;
    }

    /** Whether the process is still running. */
    get running(): boolean {
        return this.#process.exitCode === null && this.#process.signalCode === null;
    }

    /** Stop the runner the way systemd does, and wait for it to exit. */
    async stop(): Promise<void> {
        if (this.running) this.#process.kill("SIGTERM");
        await this.#exited;
    }

    /** End the runner at once with no goodbye, as a crashed machine or a cut cable would. */
    async kill(): Promise<void> {
        if (this.running) this.#process.kill("SIGKILL");
        await this.#exited;
    }

    #record(chunk: Buffer): void {
        // Keep the tail only: a long scenario must not grow the gym's memory without bound.
        this.#output = (this.#output + chunk.toString("utf8")).slice(-64 * 1024);
    }
}
