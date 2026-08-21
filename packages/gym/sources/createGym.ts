import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "@lydell/node-pty";

import { buildGymImage } from "./buildGymImage.js";
import { createFixtureWorkspace } from "./createFixtureWorkspace.js";
import { GhosttyTerminal } from "./GhosttyTerminal.js";
import { Gym } from "./Gym.js";
import { InterceptingHttpProxy } from "./InterceptingHttpProxy.js";
import { MockInferenceServer } from "./MockInferenceServer.js";
import { profileGymTiming } from "./profileGymTiming.js";
import { resolveGymExecution } from "./resolveGymExecution.js";
import { resolveGymImageTag } from "./resolveGymImageTag.js";
import {
    acquireSharedDockerRunner,
    createSharedDockerFixtureRoot,
    dockerSandboxArguments,
} from "./sharedDockerRunner.js";
import type { GymOptions } from "./types.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

export async function createGym(options: GymOptions): Promise<Gym> {
    const createStartedAt = performance.now();
    const cols = options.cols ?? 100;
    const rows = options.rows ?? 32;
    const execution = resolveGymExecution(options);
    if (
        options.mountWorkspaceIntoDockerSession === true &&
        (execution !== "docker" || options.dockerSocket !== true)
    ) {
        throw new Error(
            'Gym option "mountWorkspaceIntoDockerSession" requires mode: "docker" and dockerSocket: true.',
        );
    }
    const image =
        execution === "docker"
            ? (options.image ?? (await resolveGymImageTag(repositoryRoot)))
            : undefined;
    const dockerRunner =
        execution === "docker"
            ? await acquireSharedDockerRunner({
                  dockerSocket: options.dockerSocket === true,
                  imageId: await buildGymImage(image ?? "", repositoryRoot),
                  repositoryRoot,
              })
            : undefined;
    const dockerFixture =
        dockerRunner === undefined ? undefined : await createSharedDockerFixtureRoot(dockerRunner);
    const workspacePath = await createFixtureWorkspace(
        options.files,
        dockerFixture === undefined ? undefined : join(dockerFixture.hostRoot, "workspace"),
    ).catch(async (error: unknown) => {
        if (dockerFixture !== undefined) {
            await rm(dockerFixture.hostRoot, { force: true, recursive: true });
        }
        throw error;
    });
    let homePath: string;
    try {
        homePath = await createFixtureWorkspace(
            options.homeFiles ?? {},
            dockerFixture === undefined ? undefined : join(dockerFixture.hostRoot, "home"),
        );
    } catch (error) {
        await rm(dockerFixture?.hostRoot ?? workspacePath, { force: true, recursive: true });
        throw error;
    }
    const inference = new MockInferenceServer(options.inference ?? []);
    const httpProxy =
        options.httpProxy === undefined
            ? undefined
            : new InterceptingHttpProxy(
                  options.httpProxy === true ? undefined : options.httpProxy.handler,
              );
    const containerName = dockerRunner?.containerName ?? `happy-terminal-gym-${randomUUID()}`;
    const sessionArguments = [
        ...(options.args ?? []),
        ...(options.mountWorkspaceIntoDockerSession === true
            ? ["--docker-mount", `${workspacePath}:/workspace`]
            : []),
    ];
    const profileId = containerName.slice(-8);
    profileGymTiming(profileId, "fixtures", createStartedAt);
    const localRunnerArguments = [
        // tsx transforms the sources on any supported Node; the native
        // --experimental-transform-types flag was removed in Node 26. The absolute
        // URL keeps the import working from the gym's temporary working directory.
        "--import",
        pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
        "--import",
        join(repositoryRoot, "packages/gym/sources/registerTypeScriptSourceHooks.mjs"),
        join(repositoryRoot, "packages/happy-terminal/sources/main.ts"),
    ];
    let ghostty: GhosttyTerminal | undefined;
    let gym: Gym | undefined;
    try {
        const terminalStartedAt = performance.now();
        const startedGhostty = await GhosttyTerminal.create(
            cols,
            rows,
            options.terminalColorScheme,
            options.terminalBackgroundColorQuery,
        );
        profileGymTiming(profileId, "terminal", terminalStartedAt);
        ghostty = startedGhostty;
        const servicesStartedAt = performance.now();
        await Promise.all([inference.start(), httpProxy?.start()]);
        profileGymTiming(profileId, "services", servicesStartedAt);
        const providerId = options.providerId ?? "gym";
        const modelId = options.modelId ?? defaultModelId(providerId);
        const localEnvironment =
            execution === "local"
                ? createLocalEnvironment(options, homePath, workspacePath, inference, httpProxy)
                : undefined;
        const dockerEnvironmentArguments =
            execution === "docker"
                ? [
                      "--env",
                      `HAPPY_GYM_INFERENCE_URL=${inference.url}`,
                      "--env",
                      `HAPPY_GYM_TOKEN=${inference.token}`,
                      ...(options.contextWindow === undefined
                          ? []
                          : [
                                "--env",
                                `HAPPY_TERMINAL_GYM_CONTEXT_WINDOW=${options.contextWindow}`,
                            ]),
                      "--env",
                      "HAPPY_TERMINAL_GYM_OUTER_ISOLATION=docker",
                      ...(options.providerOverrides === undefined
                          ? []
                          : [
                                "--env",
                                `HAPPY_TERMINAL_GYM_PROVIDER_OVERRIDES=${options.providerOverrides.join(",")}`,
                            ]),
                      "--env",
                      `HAPPY_TERMINAL_MODEL=${modelId}`,
                      ...(options.permissionMode === "from_config"
                          ? []
                          : [
                                "--env",
                                `HAPPY_TERMINAL_PERMISSION_MODE=${options.permissionMode ?? "full_access"}`,
                            ]),
                      "--env",
                      `HAPPY_TERMINAL_PROVIDER=${providerId}`,
                      ...environmentArguments(options.environment, httpProxy?.url),
                      ...(httpProxy === undefined
                          ? []
                          : [
                                "--env",
                                `HTTP_PROXY=${httpProxy.url}`,
                                "--env",
                                `http_proxy=${httpProxy.url}`,
                                "--env",
                                `HTTPS_PROXY=${httpProxy.url}`,
                                "--env",
                                `https_proxy=${httpProxy.url}`,
                                "--env",
                                "NODE_USE_ENV_PROXY=1",
                            ]),
                  ]
                : undefined;
        const processStartedAt = performance.now();
        const localCommand =
            options.entrypoint === undefined
                ? [process.execPath, ...localRunnerArguments, ...sessionArguments]
                : [...options.entrypoint, ...sessionArguments];
        const pty =
            execution === "docker"
                ? spawn(
                      "docker",
                      [
                          "exec",
                          "--interactive",
                          "--tty",
                          ...(dockerEnvironmentArguments ?? []),
                          "--workdir",
                          dockerFixture?.containerRoot ?? "/workspace",
                          containerName,
                          ...dockerSandboxArguments(
                              dockerFixture?.containerRoot ?? "",
                              dockerFixture?.stateRoot ?? "",
                              options.entrypoint === undefined
                                  ? [
                                        "node",
                                        "/app/packages/happy-terminal/dist/main.js",
                                        ...sessionArguments,
                                    ]
                                  : [...options.entrypoint, ...sessionArguments],
                          ),
                      ],
                      {
                          cols,
                          cwd: repositoryRoot,
                          env: process.env as Record<string, string>,
                          name: "xterm-256color",
                          rows,
                      },
                  )
                : spawn(localCommand[0] ?? process.execPath, localCommand.slice(1), {
                      cols,
                      cwd: workspacePath,
                      env: localEnvironment ?? {},
                      name: "xterm-256color",
                      rows,
                  });
        const startedGym = new Gym({
            containerName,
            ...(dockerFixture === undefined
                ? {}
                : { dockerFixtureRoot: dockerFixture.containerRoot }),
            ...(dockerFixture === undefined
                ? {}
                : { dockerFixtureStateRoot: dockerFixture.stateRoot }),
            ...(dockerEnvironmentArguments === undefined ? {} : { dockerEnvironmentArguments }),
            execution,
            ...(dockerFixture === undefined ? {} : { fixtureRootPath: dockerFixture.hostRoot }),
            ghostty: startedGhostty,
            homePath,
            ...(httpProxy === undefined ? {} : { httpProxy }),
            inference,
            ...(localEnvironment === undefined ? {} : { localEnvironment, localRunnerArguments }),
            pty,
            workspacePath,
        });
        gym = startedGym;
        await Promise.race([
            startedGym.terminal.waitForText(
                options.startupText ?? "Ask Happy Terminal to do anything",
                options.timeoutMs ?? 20_000,
            ),
            startedGym.exit().then(async ({ exitCode, signal }) => {
                const snapshot = await startedGym.terminal.snapshot();
                throw new Error(
                    `Gym container exited before startup (code ${exitCode}, signal ${String(signal)}).\n\n${snapshot.text}`,
                );
            }),
        ]);
        profileGymTiming(profileId, "process-ready", processStartedAt);
        profileGymTiming(profileId, "create-total", createStartedAt);
        return startedGym;
    } catch (error) {
        if (gym !== undefined) {
            await gym.dispose().catch(() => {});
        } else {
            ghostty?.close();
            await Promise.all([
                inference.stop().catch(() => {}),
                httpProxy?.stop().catch(() => {}),
            ]);
            await Promise.all([
                rm(dockerFixture?.hostRoot ?? homePath, { force: true, recursive: true }),
                ...(dockerFixture === undefined
                    ? [rm(workspacePath, { force: true, recursive: true })]
                    : []),
            ]);
        }
        throw error;
    }
}

function defaultModelId(
    providerId: "bedrock" | "claude" | "codex" | "grok" | "gym" | "kimi",
): string {
    if (providerId === "bedrock") return "openai/gpt-5.6-sol";
    if (providerId === "claude") return "anthropic/sonnet-5";
    if (providerId === "codex") return "openai/gpt-5.6-sol";
    if (providerId === "grok") return "xai/grok-4.6";
    if (providerId === "kimi") return "moonshot/kimi-k3";
    return "openai/gym";
}

function environmentArguments(
    environment: Readonly<Record<string, string>> | undefined,
    httpProxyUrl?: string,
): string[] {
    if (environment === undefined) return [];
    return Object.entries(environment).flatMap(([name, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
            throw new Error(`Invalid Gym environment variable name '${name}'.`);
        }
        const expandedValue =
            httpProxyUrl === undefined
                ? value
                : value.replaceAll("{{HTTP_PROXY_URL}}", httpProxyUrl);
        return ["--env", `${name}=${expandedValue}`];
    });
}

function createLocalEnvironment(
    options: GymOptions,
    homePath: string,
    workspacePath: string,
    inference: MockInferenceServer,
    httpProxy: InterceptingHttpProxy | undefined,
): Record<string, string> {
    const environment = {
        HOME: homePath,
        PATH: process.env.PATH ?? "",
        HAPPY_TERMINAL_CONFIGURATION_DIRECTORY: join(homePath, "happy", "config"),
        HAPPY_GYM_INFERENCE_URL: inference.localUrl,
        HAPPY_GYM_TOKEN: inference.token,
        HAPPY_TERMINAL_GYM_DISPLAY_WORKSPACE: "/workspace",
        HAPPY_TERMINAL_GYM_HOME_PATH: homePath,
        HAPPY_TERMINAL_GYM_IN_PROCESS_DAEMON: "1",
        HAPPY_TERMINAL_GYM_WORKSPACE_PATH: workspacePath,
        HAPPY_TERMINAL_GYM_RUNTIME: "just-bash",
        HAPPY_TERMINAL_SERVER_DIRECTORY: join(homePath, ".server"),
        HAPPY_TERMINAL_MODEL: options.modelId ?? defaultModelId(options.providerId ?? "gym"),
        HAPPY_TERMINAL_PROVIDER: options.providerId ?? "gym",
        TERM: "xterm-256color",
        ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
        ...(options.contextWindow === undefined
            ? {}
            : { HAPPY_TERMINAL_GYM_CONTEXT_WINDOW: String(options.contextWindow) }),
        ...(options.permissionMode === "from_config"
            ? {}
            : { HAPPY_TERMINAL_PERMISSION_MODE: options.permissionMode ?? "full_access" }),
        ...(options.providerOverrides === undefined
            ? {}
            : { HAPPY_TERMINAL_GYM_PROVIDER_OVERRIDES: options.providerOverrides.join(",") }),
        ...localEnvironmentValues(options.environment, httpProxy?.localUrl),
    };
    if (httpProxy === undefined) return environment;
    return {
        ...environment,
        HTTP_PROXY: httpProxy.localUrl,
        HTTPS_PROXY: httpProxy.localUrl,
        NODE_USE_ENV_PROXY: "1",
        http_proxy: httpProxy.localUrl,
        https_proxy: httpProxy.localUrl,
    };
}

function localEnvironmentValues(
    environment: Readonly<Record<string, string>> | undefined,
    httpProxyUrl?: string,
): Record<string, string> {
    if (environment === undefined) return {};
    return Object.fromEntries(
        Object.entries(environment).map(([name, value]) => {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
                throw new Error(`Invalid Gym environment variable name '${name}'.`);
            }
            const expanded =
                httpProxyUrl === undefined
                    ? value
                    : value.replaceAll("{{HTTP_PROXY_URL}}", httpProxyUrl);
            return [
                name,
                httpProxyUrl !== undefined && /^(?:NO_PROXY|no_proxy)$/u.test(name)
                    ? `${expanded},127.0.0.1,localhost`
                    : expanded,
            ];
        }),
    );
}
