import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import type { IPty } from "@lydell/node-pty";

import { connectGymTerminal } from "./connectGymTerminal.js";
import { GhosttyTerminal } from "./GhosttyTerminal.js";
import { GymTerminal } from "./GymTerminal.js";
import type { InterceptingHttpProxy } from "./InterceptingHttpProxy.js";
import { killDockerGymProcesses } from "./killDockerGymProcesses.js";
import { MockInferenceServer } from "./MockInferenceServer.js";
import { profileGymTiming } from "./profileGymTiming.js";
import { resolveWorkspacePath } from "./resolveWorkspacePath.js";
import { dockerSandboxArguments } from "./sharedDockerRunner.js";

const execFileAsync = promisify(execFile);

export class Gym {
    readonly dockerContainerName: string;
    readonly httpProxy: InterceptingHttpProxy | undefined;
    readonly inference: MockInferenceServer;
    readonly terminal: GymTerminal;
    readonly workspacePath: string;

    #containerName: string;
    #disconnectTerminal: () => void;
    #dockerFixtureRoot: string | undefined;
    #dockerFixtureStateRoot: string | undefined;
    #dockerEnvironmentArguments: readonly string[] | undefined;
    #disposed = false;
    #execution: "docker" | "local";
    #exit: Promise<{ exitCode: number; signal?: number }>;
    #fixtureRootPath: string | undefined;
    #ghostty: GhosttyTerminal;
    #homePath: string | undefined;
    #localEnvironment: Record<string, string> | undefined;
    #localRunnerArguments: readonly string[] | undefined;
    #pty: IPty;

    constructor(options: {
        containerName: string;
        dockerFixtureRoot?: string;
        dockerFixtureStateRoot?: string;
        dockerEnvironmentArguments?: readonly string[];
        execution: "docker" | "local";
        fixtureRootPath?: string;
        ghostty: GhosttyTerminal;
        homePath?: string;
        httpProxy?: InterceptingHttpProxy;
        inference: MockInferenceServer;
        localEnvironment?: Record<string, string>;
        localRunnerArguments?: readonly string[];
        pty: IPty;
        workspacePath: string;
    }) {
        this.dockerContainerName = options.containerName;
        this.#containerName = options.containerName;
        this.#disconnectTerminal = connectGymTerminal(options.pty, options.ghostty);
        this.#dockerFixtureRoot = options.dockerFixtureRoot;
        this.#dockerFixtureStateRoot = options.dockerFixtureStateRoot;
        this.#dockerEnvironmentArguments = options.dockerEnvironmentArguments;
        this.#ghostty = options.ghostty;
        this.#execution = options.execution;
        this.#fixtureRootPath = options.fixtureRootPath;
        this.#homePath = options.homePath;
        this.#localEnvironment = options.localEnvironment;
        this.#localRunnerArguments = options.localRunnerArguments;
        this.#pty = options.pty;
        this.httpProxy = options.httpProxy;
        this.inference = options.inference;
        this.terminal = new GymTerminal(
            options.pty,
            options.ghostty,
            () => options.inference.handlerFailures,
        );
        this.workspacePath = options.workspacePath;
        this.#exit = new Promise((resolve) => {
            options.pty.onExit(resolve);
        });
    }

    async dispose(): Promise<void> {
        if (this.#disposed) return;
        const disposeStartedAt = performance.now();
        const profileId = this.#containerName.slice(-8);
        const inProcessDaemon =
            this.#execution === "local" &&
            this.#localEnvironment?.HAPPY_TERMINAL_GYM_IN_PROCESS_DAEMON === "1";
        this.#disposed = true;
        this.#disconnectTerminal();
        this.#pty.kill(inProcessDaemon ? "SIGKILL" : undefined);
        await waitForExit(this.#exit, 1_000);
        if (this.#execution === "docker") {
            if (this.#dockerFixtureRoot === undefined) {
                await execFileAsync("docker", ["rm", "--force", this.#containerName]).catch(
                    () => {},
                );
            } else {
                await killDockerGymProcesses(this.#containerName, this.#dockerFixtureRoot);
                if (this.#dockerFixtureStateRoot !== undefined) {
                    await execFileAsync("docker", [
                        "exec",
                        this.#containerName,
                        "rm",
                        "-rf",
                        this.#dockerFixtureStateRoot,
                    ]).catch(() => {});
                }
            }
        } else if (
            this.#localEnvironment !== undefined &&
            this.#localRunnerArguments !== undefined &&
            this.#localEnvironment.HAPPY_TERMINAL_GYM_IN_PROCESS_DAEMON !== "1"
        ) {
            const daemonStartedAt = performance.now();
            await execFileAsync(
                process.execPath,
                [...this.#localRunnerArguments, "daemon", "stop"],
                {
                    cwd: this.workspacePath,
                    env: this.#localEnvironment,
                    timeout: 10_000,
                },
            ).catch(() => {});
            profileGymTiming(profileId, "dispose-daemon", daemonStartedAt);
        }
        this.#ghostty.close();
        const servicesStartedAt = performance.now();
        await Promise.all([this.inference.stop(), this.httpProxy?.stop()]);
        profileGymTiming(profileId, "dispose-services", servicesStartedAt);
        const filesStartedAt = performance.now();
        const removeOptions = {
            force: true,
            maxRetries: 5,
            recursive: true,
            retryDelay: 50,
        } as const;
        await Promise.all(
            this.#fixtureRootPath === undefined
                ? [
                      ...(this.#homePath === undefined ? [] : [rm(this.#homePath, removeOptions)]),
                      rm(this.workspacePath, removeOptions),
                  ]
                : [rm(this.#fixtureRootPath, removeOptions)],
        );
        profileGymTiming(profileId, "dispose-files", filesStartedAt);
        profileGymTiming(profileId, "dispose-total", disposeStartedAt);
    }

    exit(): Promise<{ exitCode: number; signal?: number }> {
        return this.#exit;
    }

    readFile(path: string): Promise<string> {
        return readFile(resolveWorkspacePath(this.workspacePath, path), "utf8");
    }

    async runInContainer(
        command: string,
        args: readonly string[] = [],
        options: { timeoutMs?: number } = {},
    ): Promise<{ stderr: string; stdout: string }> {
        if (this.#disposed) throw new Error("Cannot run a command in a disposed Gym.");
        const commandArguments =
            this.#execution === "docker"
                ? [
                      "exec",
                      ...(this.#dockerEnvironmentArguments ?? []),
                      "--workdir",
                      this.#dockerFixtureRoot ?? "/workspace",
                      this.#containerName,
                      ...(this.#dockerFixtureRoot === undefined
                          ? [command, ...args]
                          : dockerSandboxArguments(
                                this.#dockerFixtureRoot,
                                this.#dockerFixtureStateRoot ?? "",
                                [command, ...args],
                            )),
                  ]
                : args.map((argument) =>
                      argument
                          .replaceAll("/workspace", this.workspacePath)
                          .replaceAll(
                              "/home/happy-terminal",
                              this.#homePath ?? "/home/happy-terminal",
                          ),
                  );
        const localCommand = command
            .replaceAll("/workspace", this.workspacePath)
            .replaceAll("/home/happy-terminal", this.#homePath ?? "/home/happy-terminal");
        const { stderr, stdout } = await execFileAsync(
            this.#execution === "docker" ? "docker" : localCommand,
            commandArguments,
            {
                cwd: this.#execution === "docker" ? undefined : this.workspacePath,
                env: this.#execution === "local" ? this.#localEnvironment : undefined,
                maxBuffer: 10 * 1024 * 1024,
                timeout: options.timeoutMs ?? 30_000,
            },
        );
        return { stderr, stdout };
    }
}

async function waitForExit(
    exit: Promise<{ exitCode: number; signal?: number }>,
    timeoutMs: number,
): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
        exit.then(() => undefined),
        new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
            timer.unref?.();
        }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
}
