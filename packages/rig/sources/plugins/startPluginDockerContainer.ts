import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Duplex, PassThrough } from "node:stream";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import Dockerode from "dockerode";

import { errorToMessage } from "../errorToMessage.js";
import { isDockerNotFoundError } from "../execution/isDockerNotFoundError.js";
import {
    createPluginDockerContainerName,
    createPluginDockerContainerOptions,
} from "./createPluginDockerContainerOptions.js";
import { resolvePluginSdkRuntimePaths } from "./createPluginNodeRuntime.js";
import {
    createPluginDockerFolderIdentity,
    PLUGIN_DOCKER_FOLDER_LABEL,
    PLUGIN_DOCKER_MANAGED_LABEL,
} from "./pluginDockerOwnership.js";
import { resolvePluginDockerImage } from "./resolvePluginDockerRuntime.js";
import type { RegisteredPlugin } from "./types.js";
import {
    PLUGIN_DOCKER_CLEANUP_TIMEOUT_MS,
    withPluginDockerDeadline,
} from "./withPluginDockerDeadline.js";

const dockerImageInspectSchema = Type.Object(
    {
        Config: Type.Object(
            {
                Env: Type.Optional(Type.Array(Type.String())),
            },
            { additionalProperties: true },
        ),
    },
    { additionalProperties: true },
);
const dockerWaitResultSchema = Type.Object(
    {
        StatusCode: Type.Integer(),
    },
    { additionalProperties: true },
);
const dockerContainerInspectSchema = Type.Object(
    {
        Config: Type.Object(
            {
                Labels: Type.Optional(Type.Record(Type.String(), Type.String())),
            },
            { additionalProperties: true },
        ),
    },
    { additionalProperties: true },
);
const dockerContainerListSchema = Type.Array(
    Type.Object(
        {
            Id: Type.String({ minLength: 1 }),
            Labels: Type.Record(Type.String(), Type.String()),
        },
        { additionalProperties: true },
    ),
);
const dockerAlreadyStoppedErrorSchema = Type.Object(
    {
        statusCode: Type.Literal(304),
    },
    { additionalProperties: true },
);
const dockerRemovalInProgressErrorSchema = Type.Object(
    {
        statusCode: Type.Literal(409),
    },
    { additionalProperties: true },
);

class PluginDockerContainerNameConflictError extends Error {}

export interface RunningPluginDockerContainer {
    readonly completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    readonly containerName: string;
    readonly pid: undefined;
    readonly stderr: NodeJS.ReadableStream;
    readonly stdout: NodeJS.ReadableStream;
    close(options?: { force?: boolean }): Promise<void>;
}

export async function startPluginDockerContainer(options: {
    cleanupTimeoutMs?: number;
    dataDirectory: string;
    docker?: Dockerode;
    environment: NodeJS.ProcessEnv;
    plugin: RegisteredPlugin;
    socketBridgePort?: number;
    token: string;
}): Promise<RunningPluginDockerContainer> {
    const { plugin } = options;
    if (plugin.docker === undefined || plugin.manifest.main === undefined) {
        throw new Error("A native plugin cannot start as a Docker container.");
    }
    const docker = options.docker ?? new Dockerode();
    const image = await resolvePluginDockerImage(plugin);
    const cleanupTimeoutMs = options.cleanupTimeoutMs ?? PLUGIN_DOCKER_CLEANUP_TIMEOUT_MS;
    const containerName = createPluginDockerContainerName({
        directory: plugin.directory,
        folderName: plugin.folderName,
        image,
    });
    const tokenFilePath = join(options.dataDirectory, ".runtime", `${containerName}.token`);
    let imageEnvironment: readonly string[];
    try {
        await removeOwnedPluginContainers(docker, plugin.folderName, cleanupTimeoutMs);
        await assertContainerNameAvailable(
            docker,
            containerName,
            plugin.folderName,
            cleanupTimeoutMs,
        );
        const inspected = await docker.getImage(image).inspect();
        if (!Value.Check(dockerImageInspectSchema, inspected)) {
            throw new Error("Docker returned invalid image metadata.");
        }
        imageEnvironment = inspected.Config.Env ?? [];
    } catch (error) {
        if (error instanceof PluginDockerContainerNameConflictError) throw error;
        if (isDockerNotFoundError(error)) {
            throw new Error(
                `Docker image '${image}' is not available for the ${plugin.manifest.name} plugin. Reinstall the plugin to prepare it.`,
            );
        }
        throw new Error(
            `Rig could not inspect the Docker resources needed to start the ${plugin.manifest.name} plugin: ${errorToMessage(error)}`,
        );
    }

    const paths = await resolvePluginSdkRuntimePaths();
    // The containing .runtime directory is 0700. The file itself must still be
    // world-readable because some VM file-sharing runtimes preserve the host UID
    // on bind mounts while the container has every capability dropped.
    await writeFile(tokenFilePath, `${options.token}\n`, { mode: 0o644 });
    await chmod(tokenFilePath, 0o644);
    let container: Dockerode.Container;
    try {
        container = await docker.createContainer(
            createPluginDockerContainerOptions({
                bootstrapPath: paths.dockerBootstrapPath,
                codeDirectory: plugin.directory,
                containerName,
                dataDirectory: options.dataDirectory,
                entryPath: plugin.manifest.main,
                environment: options.environment,
                folderName: plugin.folderName,
                image,
                imageEnvironment,
                loaderPath: paths.loaderPath,
                sdkModuleDirectory: paths.sdkModuleDirectory,
                ...(options.socketBridgePort === undefined
                    ? {}
                    : { socketBridgePort: options.socketBridgePort }),
                tokenFilePath,
                typeboxModuleDirectory: paths.typeboxModuleDirectory,
                ...(process.platform === "linux"
                    ? {
                          user: `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`,
                      }
                    : {}),
            }),
        );
    } catch (error) {
        await rm(tokenFilePath, { force: true });
        throw new Error(
            `Rig could not create the ${plugin.manifest.name} plugin container: ${errorToMessage(error)}`,
        );
    }
    let output: Duplex | undefined;
    try {
        output = (await container.attach({
            logs: true,
            stream: true,
            stderr: true,
            stdout: true,
        })) as Duplex;
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        container.modem.demuxStream(output, stdout, stderr);
        await container.start();
        const outputCompletion = waitForOutputCompletion(output);
        const completion = Promise.all([
            container.wait().then((result: unknown) => {
                if (!Value.Check(dockerWaitResultSchema, result)) {
                    throw new Error("Docker returned an invalid plugin exit result.");
                }
                return { code: result.StatusCode, signal: null };
            }),
            outputCompletion,
        ]).then(([result]) => result);
        let gracefulClose: Promise<void> | undefined;
        let forcedClose: Promise<void> | undefined;
        return {
            completion,
            containerName,
            pid: undefined,
            stderr,
            stdout,
            close(closeOptions = {}) {
                if (closeOptions.force === true) {
                    return (forcedClose ??= closeContainer(
                        container,
                        completion,
                        cleanupTimeoutMs,
                        output!,
                        true,
                    ).finally(() => rm(tokenFilePath, { force: true })));
                }
                return (gracefulClose ??= closeContainer(
                    container,
                    completion,
                    cleanupTimeoutMs,
                    output!,
                    false,
                ).finally(() => rm(tokenFilePath, { force: true })));
            },
        };
    } catch (error) {
        output?.destroy();
        await Promise.allSettled([
            withPluginDockerDeadline(removeContainer(container), {
                action: `Removing failed Docker container '${containerName}'`,
                timeoutMs: cleanupTimeoutMs,
            }),
            rm(tokenFilePath, { force: true }),
        ]);
        throw new Error(
            `Rig could not start Docker container '${containerName}' for the ${plugin.manifest.name} plugin: ${errorToMessage(error)}`,
        );
    }
}

function waitForOutputCompletion(output: Duplex): Promise<void> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            if (error === undefined) resolve();
            else reject(error);
        };
        output.once("end", () => finish());
        output.once("close", () => finish());
        output.once("error", finish);
    });
}

export async function removePluginDockerContainers(
    folderName: string,
    options: { docker?: Dockerode; timeoutMs?: number } = {},
): Promise<void> {
    const docker = options.docker ?? new Dockerode();
    const timeoutMs = options.timeoutMs ?? PLUGIN_DOCKER_CLEANUP_TIMEOUT_MS;
    try {
        await withPluginDockerDeadline(removeOwnedPluginContainers(docker, folderName, timeoutMs), {
            action: `Removing Docker containers for the ${folderName} plugin`,
            timeoutMs,
        });
    } catch (error) {
        throw new Error(
            `Rig could not remove Docker containers for the ${folderName} plugin: ${errorToMessage(error)}`,
        );
    }
}

async function removeOwnedPluginContainers(
    docker: Dockerode,
    folderName: string,
    timeoutMs: number,
): Promise<void> {
    const identity = createPluginDockerFolderIdentity(folderName);
    const listed: unknown = await docker.listContainers({
        all: true,
        filters: {
            label: [
                `${PLUGIN_DOCKER_MANAGED_LABEL}=true`,
                `${PLUGIN_DOCKER_FOLDER_LABEL}=${identity}`,
            ],
        },
    });
    if (!Value.Check(dockerContainerListSchema, listed)) {
        throw new Error("Docker returned an invalid plugin container list.");
    }
    await Promise.all(
        listed.map(async (candidate) => {
            if (
                candidate.Labels[PLUGIN_DOCKER_MANAGED_LABEL] !== "true" ||
                candidate.Labels[PLUGIN_DOCKER_FOLDER_LABEL] !== identity
            ) {
                return;
            }
            await withPluginDockerDeadline(removeContainer(docker.getContainer(candidate.Id)), {
                action: `Removing a stale Docker container for the ${folderName} plugin`,
                timeoutMs,
            });
        }),
    );
}

async function assertContainerNameAvailable(
    docker: Dockerode,
    name: string,
    folderName: string,
    timeoutMs: number,
): Promise<void> {
    const candidate = docker.getContainer(name);
    let inspected: unknown;
    try {
        inspected = await candidate.inspect();
    } catch (error) {
        if (isDockerNotFoundError(error)) return;
        throw error;
    }
    if (!Value.Check(dockerContainerInspectSchema, inspected)) {
        throw new PluginDockerContainerNameConflictError(
            `Docker container name '${name}' is already in use, and Docker returned invalid ownership metadata for it.`,
        );
    }
    const identity = createPluginDockerFolderIdentity(folderName);
    if (
        inspected.Config.Labels?.[PLUGIN_DOCKER_MANAGED_LABEL] === "true" &&
        inspected.Config.Labels[PLUGIN_DOCKER_FOLDER_LABEL] === identity
    ) {
        await withPluginDockerDeadline(removeContainer(candidate), {
            action: `Removing the previous Docker container for the ${folderName} plugin`,
            timeoutMs,
        });
        return;
    }
    throw new PluginDockerContainerNameConflictError(
        `Docker container name '${name}' is already in use by a container Rig does not own.`,
    );
}

async function closeContainer(
    container: Dockerode.Container,
    completion: Promise<unknown>,
    cleanupTimeoutMs: number,
    output: Duplex,
    force: boolean,
): Promise<void> {
    try {
        if (force) {
            await withPluginDockerDeadline(removeContainer(container), {
                action: "Force-removing the Docker plugin container",
                timeoutMs: cleanupTimeoutMs,
            });
        } else {
            await withPluginDockerDeadline(
                container.stop({ t: 2 }).catch((error: unknown) => {
                    if (!isContainerAlreadyStopped(error) && !isDockerNotFoundError(error)) {
                        throw error;
                    }
                }),
                {
                    action: "Stopping the Docker plugin container",
                    timeoutMs: cleanupTimeoutMs,
                },
            ).catch(() => undefined);
            await withPluginDockerDeadline(
                completion.catch(() => undefined),
                {
                    action: "Waiting for the Docker plugin container to stop",
                    timeoutMs: cleanupTimeoutMs,
                },
            ).catch(() => undefined);
            await withPluginDockerDeadline(removeContainer(container), {
                action: "Removing the Docker plugin container",
                timeoutMs: cleanupTimeoutMs,
            });
        }
    } finally {
        output.destroy();
    }
}

function isContainerAlreadyStopped(error: unknown): boolean {
    return Value.Check(dockerAlreadyStoppedErrorSchema, error);
}

async function removeContainer(container: Dockerode.Container): Promise<void> {
    try {
        await container.remove({ force: true });
    } catch (error) {
        if (isDockerNotFoundError(error)) return;
        if (!Value.Check(dockerRemovalInProgressErrorSchema, error)) throw error;
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline) {
            try {
                await container.inspect();
            } catch (inspectError) {
                if (isDockerNotFoundError(inspectError)) return;
                throw inspectError;
            }
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, 25);
                timer.unref();
            });
        }
        throw error;
    }
}
