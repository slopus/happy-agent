import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SHARED_DOCKER_RUNNER_VERSION = "3";
const runners = new Map<string, Promise<SharedDockerRunner>>();

export interface SharedDockerRunner {
    containerName: string;
    containerRoot: string;
    hostRoot: string;
}

export function acquireSharedDockerRunner(options: {
    dockerSocket: boolean;
    imageId: string;
    repositoryRoot: string;
}): Promise<SharedDockerRunner> {
    const key = `${SHARED_DOCKER_RUNNER_VERSION}\0${options.imageId}\0${String(options.dockerSocket)}\0${options.repositoryRoot}`;
    let runner = runners.get(key);
    if (runner === undefined) {
        runner = startSharedDockerRunner(options).catch((error: unknown) => {
            runners.delete(key);
            throw error;
        });
        runners.set(key, runner);
    }
    return runner;
}

export async function createSharedDockerFixtureRoot(
    runner: SharedDockerRunner,
): Promise<{ containerRoot: string; hostRoot: string; stateRoot: string }> {
    const id = randomUUID();
    const hostRoot = join(runner.hostRoot, id);
    const stateRoot = `/gym-state/${id}`;
    await mkdir(hostRoot, { recursive: true });
    await chmod(hostRoot, 0o777);
    await execFileAsync("docker", [
        "exec",
        runner.containerName,
        "mkdir",
        "-p",
        `${stateRoot}/tmp`,
        `${stateRoot}/agent`,
    ]);
    return {
        containerRoot: `${runner.containerRoot}/${id}`,
        hostRoot,
        stateRoot,
    };
}

export function dockerSandboxArguments(
    containerRoot: string,
    stateRoot: string,
    command: readonly string[],
): string[] {
    return [
        "bwrap",
        "--unshare-user",
        "--unshare-ipc",
        "--unshare-uts",
        "--bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--bind",
        `${containerRoot}/workspace`,
        "/workspace",
        "--bind",
        `${containerRoot}/home`,
        "/home/happy-terminal",
        "--bind",
        `${stateRoot}/tmp`,
        "/tmp",
        // The fixture home is a macOS-backed volume that cannot hold the daemon's Unix socket,
        // so the daemon's private directory lives on container-local storage instead.
        "--bind",
        `${stateRoot}/agent`,
        "/home/happy-terminal/.happy/agent",
        "--tmpfs",
        "/gyms",
        "--tmpfs",
        "/gym-state",
        "--chdir",
        "/workspace",
        "--",
        ...command,
    ];
}

async function startSharedDockerRunner(options: {
    dockerSocket: boolean;
    imageId: string;
    repositoryRoot: string;
}): Promise<SharedDockerRunner> {
    const runId = process.env.HAPPY_TERMINAL_GYM_RUN_ID ?? `process-${String(process.pid)}`;
    const safeRunId = runId.replaceAll(/[^A-Za-z0-9_.-]/gu, "-").slice(0, 48);
    const keyHash = createHash("sha256")
        .update(SHARED_DOCKER_RUNNER_VERSION)
        .update(options.imageId)
        .update(String(options.dockerSocket))
        .update(options.repositoryRoot)
        .digest("hex")
        .slice(0, 12);
    const containerName = `happy-terminal-gym-pool-${safeRunId}-${keyHash}`;
    const hostRoot = join(tmpdir(), `happy-terminal-gym-pool-${safeRunId}-${keyHash}`);
    const containerRoot = "/gyms";
    await mkdir(hostRoot, { recursive: true });
    await chmod(hostRoot, 0o777);

    const running = await inspectRunning(containerName);
    if (!running) {
        const arguments_ = [
            "run",
            "--detach",
            "--init",
            "--name",
            containerName,
            "--label",
            `happy-terminal.gym.run=${runId}`,
            "--security-opt",
            "seccomp=unconfined",
            "--add-host",
            "host.docker.internal:host-gateway",
            "--env",
            "NODE_OPTIONS=--experimental-transform-types --import=/app/happy-terminal-source-hook.mjs",
            "--volume",
            `${hostRoot}:${containerRoot}`,
            ...(options.dockerSocket ? ["--volume", `${hostRoot}:${hostRoot}`] : []),
            "--volume",
            `${join(options.repositoryRoot, "packages/happy-terminal/sources")}:/app/packages/happy-terminal/sources:ro`,
            "--volume",
            `${join(options.repositoryRoot, "packages/happy-terminal/package.json")}:/app/packages/happy-terminal/package.json:ro`,
            "--volume",
            `${join(options.repositoryRoot, "packages/gym/sources/registerTypeScriptSourceHooks.mjs")}:/app/happy-terminal-source-hook.mjs:ro`,
            "--tmpfs",
            "/gym-state:uid=1000,gid=1000,mode=0777",
            ...(options.dockerSocket
                ? [
                      "--group-add",
                      "0",
                      "--group-add",
                      await dockerSocketGroupId(),
                      "--volume",
                      "/var/run/docker.sock:/var/run/docker.sock",
                  ]
                : []),
            "--entrypoint",
            "sleep",
            options.imageId,
            "infinity",
        ];
        await execFileAsync("docker", arguments_).catch(async (error: unknown) => {
            if (!(await waitForRunning(containerName))) throw error;
        });
    }

    return { containerName, containerRoot, hostRoot };
}

async function inspectRunning(containerName: string): Promise<boolean> {
    return execFileAsync("docker", ["inspect", "--format", "{{.State.Running}}", containerName])
        .then(({ stdout }) => stdout.trim() === "true")
        .catch(() => false);
}

async function waitForRunning(containerName: string): Promise<boolean> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        if (await inspectRunning(containerName)) return true;
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 25);
        });
    }
    return false;
}

async function dockerSocketGroupId(): Promise<string> {
    return String((await stat("/var/run/docker.sock")).gid);
}
