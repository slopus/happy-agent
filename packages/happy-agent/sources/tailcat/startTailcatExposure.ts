import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, rm, writeFile } from "node:fs/promises";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { resolveTailcatExecutable } from "./resolveTailcatExecutable.js";
import { startTcpRelay, type TcpRelay, type TcpRelayTarget } from "./startTcpRelay.js";

const TAILCAT_ADDRESS_SCHEMA = Type.String({
    maxLength: 8_192,
    minLength: 3,
    pattern: "^tc[A-Za-z0-9_-]+$",
});
const MAX_PROCESS_OUTPUT_BYTES = 8_192;

export interface TailcatExposurePaths {
    readonly addressPath: string;
    readonly home: string;
    readonly keyPath: string;
    readonly portPath: string;
}

export interface TailcatExposureOptions {
    readonly executable?: string;
    readonly restartDelayMs?: number;
    readonly startupTimeoutMs?: number;
    readonly stopGraceMs?: number;
}

export interface TailcatExposure {
    readonly address: string;
    readonly port: number;
    close(): Promise<void>;
}

/** Open and supervise an account-free Tailcat transport around the authenticated Happy API. */
export async function startTailcatExposure(
    ctx: Context,
    target: TcpRelayTarget,
    paths: TailcatExposurePaths,
    options: TailcatExposureOptions = {},
): Promise<TailcatExposure> {
    await mkdir(paths.home, { mode: 0o700, recursive: true });
    await chmod(paths.home, 0o700);
    const executable = options.executable ?? resolveTailcatExecutable();
    await ensureTailcatKey(executable, paths, options.startupTimeoutMs ?? 60_000);
    const relay = await startTcpRelay(target);
    const exposure = new SupervisedTailcatExposure(ctx, executable, paths, relay, options);
    try {
        return await exposure.open();
    } catch (error) {
        await exposure.close().catch(() => undefined);
        throw error;
    }
}

class SupervisedTailcatExposure implements TailcatExposure {
    readonly #ctx: Context;
    readonly #executable: string;
    readonly #paths: TailcatExposurePaths;
    readonly #relay: TcpRelay;
    readonly #restartDelayMs: number;
    readonly #startupTimeoutMs: number;
    readonly #stopGraceMs: number;
    #address = "";
    #closing: Promise<void> | undefined;
    #current: TailcatRun | undefined;
    #restartTimer: NodeJS.Timeout | undefined;
    #resumeRestart: (() => void) | undefined;
    #stopped = false;
    #supervision: Promise<void> | undefined;

    constructor(
        ctx: Context,
        executable: string,
        paths: TailcatExposurePaths,
        relay: TcpRelay,
        options: TailcatExposureOptions,
    ) {
        this.#ctx = ctx;
        this.#executable = executable;
        this.#paths = paths;
        this.#relay = relay;
        this.#restartDelayMs = options.restartDelayMs ?? 1_000;
        this.#startupTimeoutMs = options.startupTimeoutMs ?? 60_000;
        this.#stopGraceMs = options.stopGraceMs ?? 2_000;
    }

    get address(): string {
        return this.#address;
    }

    get port(): number {
        return this.#relay.port;
    }

    async open(): Promise<this> {
        this.#current = await spawnTailcat(
            this.#executable,
            this.#paths.keyPath,
            this.#paths.addressPath,
            this.#relay.port,
        );
        this.#address = await waitForTailcatAddress(
            this.#current,
            this.#paths.addressPath,
            this.#startupTimeoutMs,
        );
        await chmod(this.#paths.addressPath, 0o600);
        await writeFile(this.#paths.portPath, `${String(this.#relay.port)}\n`, { mode: 0o600 });
        await chmod(this.#paths.portPath, 0o600);
        this.#ctx.log.info(
            `tailcat:open address=${this.#address} port=${String(this.#relay.port)} pid=${String(this.#current.child.pid ?? 0)}`,
        );
        this.#supervision = this.#supervise();
        return this;
    }

    close(): Promise<void> {
        this.#closing ??= (async () => {
            this.#stopped = true;
            this.#resumeRestart?.();
            await stopTailcat(this.#current, this.#stopGraceMs);
            await this.#supervision;
            await this.#relay.close();
            await Promise.all([
                rm(this.#paths.addressPath, { force: true }),
                rm(this.#paths.portPath, { force: true }),
            ]);
            this.#ctx.log.info("tailcat:closed");
        })();
        return this.#closing;
    }

    async #supervise(): Promise<void> {
        while (!this.#stopped) {
            const current = this.#current;
            if (current !== undefined) {
                const outcome = await current.exit;
                if (this.#current === current) this.#current = undefined;
                if (this.#stopped) return;
                this.#ctx.log.warn(
                    `tailcat:exited code=${String(outcome.code)} signal=${outcome.signal ?? "none"}${outcome.stderr === "" ? "" : ` stderr=${outcome.stderr}`}`,
                );
            }
            await this.#waitBeforeRestart();
            if (this.#stopped) return;
            try {
                const restarted = await spawnTailcat(
                    this.#executable,
                    this.#paths.keyPath,
                    this.#paths.addressPath,
                    this.#relay.port,
                );
                this.#current = restarted;
                this.#address = await waitForTailcatAddress(
                    restarted,
                    this.#paths.addressPath,
                    this.#startupTimeoutMs,
                );
                await chmod(this.#paths.addressPath, 0o600);
                this.#ctx.log.info(
                    `tailcat:reopened address=${this.#address} port=${String(this.#relay.port)} pid=${String(restarted.child.pid ?? 0)}`,
                );
            } catch (error: unknown) {
                this.#ctx.log.warn(
                    `tailcat:restart-failed error=${error instanceof Error ? error.message : String(error)}`,
                );
                await stopTailcat(this.#current, this.#stopGraceMs);
                this.#current = undefined;
            }
        }
    }

    async #waitBeforeRestart(): Promise<void> {
        if (this.#stopped) return;
        await new Promise<void>((resolve) => {
            const finish = () => {
                if (this.#restartTimer !== undefined) clearTimeout(this.#restartTimer);
                this.#restartTimer = undefined;
                this.#resumeRestart = undefined;
                resolve();
            };
            this.#resumeRestart = finish;
            this.#restartTimer = setTimeout(finish, this.#restartDelayMs);
            this.#restartTimer.unref();
        });
    }
}

interface TailcatExit {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stderr: string;
}

interface TailcatRun {
    readonly child: ChildProcess;
    readonly exit: Promise<TailcatExit>;
}

async function ensureTailcatKey(
    executable: string,
    paths: TailcatExposurePaths,
    timeoutMs: number,
): Promise<void> {
    if (await isPrivateRegularFile(paths.keyPath)) return;
    const temporaryKeyPath = `${paths.keyPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        const run = spawnCommand(executable, [
            "genkey",
            `--key=${temporaryKeyPath}`,
            "--fixed-region",
        ]);
        const outcome = await waitForExit(run, timeoutMs, "Tailcat key generation");
        if (outcome.code !== 0) {
            throw new Error(
                `Tailcat could not generate its identity key.${outcome.stderr === "" ? "" : ` ${outcome.stderr}`}`,
            );
        }
        if (!(await isPrivateRegularFile(temporaryKeyPath))) {
            throw new Error("Tailcat did not create a private identity key.");
        }
        try {
            await link(temporaryKeyPath, paths.keyPath);
        } catch (error) {
            if (!isAlreadyExists(error)) throw error;
        }
        if (!(await isPrivateRegularFile(paths.keyPath))) {
            throw new Error("The persisted Tailcat identity key is not a private regular file.");
        }
    } finally {
        await rm(temporaryKeyPath, { force: true });
    }
}

async function spawnTailcat(
    executable: string,
    keyPath: string,
    addressPath: string,
    port: number,
): Promise<TailcatRun> {
    await rm(addressPath, { force: true });
    return spawnCommand(executable, [`--key=${keyPath}`, "serve", String(port)], {
        ...process.env,
        TAILCAT_ADDR_FILE: addressPath,
    });
}

function spawnCommand(
    executable: string,
    arguments_: readonly string[],
    environment: NodeJS.ProcessEnv = process.env,
): TailcatRun {
    const child = spawn(executable, [...arguments_], {
        env: environment,
        stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-MAX_PROCESS_OUTPUT_BYTES);
    });
    const exit = new Promise<TailcatExit>((resolve) => {
        let settled = false;
        const finish = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
            if (settled) return;
            settled = true;
            resolve({
                code,
                signal,
                stderr: (error?.message ?? stderr).trim().slice(-MAX_PROCESS_OUTPUT_BYTES),
            });
        };
        child.once("error", (error) => finish(null, null, error));
        child.once("exit", (code, signal) => finish(code, signal));
    });
    return { child, exit };
}

async function waitForTailcatAddress(
    run: TailcatRun,
    addressPath: string,
    timeoutMs: number,
): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let exited: TailcatExit | undefined;
    void run.exit.then((outcome) => {
        exited = outcome;
    });
    while (Date.now() < deadline) {
        const address = await readTailcatAddress(addressPath);
        if (address !== undefined) return address;
        if (exited !== undefined) {
            throw new Error(
                `Tailcat exited before opening its tunnel.${exited.stderr === "" ? "" : ` ${exited.stderr}`}`,
            );
        }
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, 25);
            timer.unref();
        });
    }
    await stopTailcat(run, 2_000);
    throw new Error("Tailcat timed out while opening its tunnel.");
}

async function readTailcatAddress(path: string): Promise<string | undefined> {
    let file;
    try {
        file = await open(path, "r");
        const bytes = Buffer.allocUnsafe(8_193);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 8_192) throw new Error("The Tailcat address file is too large.");
        const value = bytes.subarray(0, bytesRead).toString("utf8").trim();
        if (!Value.Check(TAILCAT_ADDRESS_SCHEMA, value)) {
            throw new Error("Tailcat wrote an invalid connection address.");
        }
        return value;
    } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
    } finally {
        await file?.close().catch(() => undefined);
    }
}

async function waitForExit(
    run: TailcatRun,
    timeoutMs: number,
    operation: string,
): Promise<TailcatExit> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            run.exit,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${operation} timed out.`)), timeoutMs);
                timer.unref();
            }),
        ]);
    } catch (error) {
        await stopTailcat(run, 2_000);
        throw error;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

async function stopTailcat(run: TailcatRun | undefined, graceMs: number): Promise<void> {
    if (run === undefined) return;
    if (run.child.exitCode !== null || run.child.signalCode !== null) {
        await run.exit;
        return;
    }
    run.child.kill("SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    const forced = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
            run.child.kill("SIGKILL");
            resolve();
        }, graceMs);
        timer.unref();
    });
    await Promise.race([run.exit.then(() => undefined), forced]);
    if (timer !== undefined) clearTimeout(timer);
    await run.exit;
}

async function isPrivateRegularFile(path: string): Promise<boolean> {
    try {
        const information = await lstat(path);
        if (!information.isFile() || information.isSymbolicLink()) return false;
        if (
            typeof process.getuid === "function" &&
            typeof information.uid === "number" &&
            information.uid !== process.getuid()
        ) {
            return false;
        }
        await chmod(path, 0o600);
        return true;
    } catch (error) {
        if (isMissing(error)) return false;
        throw error;
    }
}

function isMissing(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "EEXIST";
}
