import Dockerode from "dockerode";
import { posix } from "node:path";
import {
    resolveLinuxSupervisorBinary,
    type LinuxSupervisorArchitecture,
} from "@slopus/happy-agent-supervisor";

import { errorToMessage } from "./impl/errorToMessage.js";
import type { DockerExecutionConfig } from "./DockerExecutionConfig.js";
import { isDockerNotFoundError } from "./impl/isDockerNotFoundError.js";
import { DOCKER_SUPERVISOR_PATH } from "./impl/createDockerSupervisorCommand.js";
import { runDockerExec } from "./impl/runDockerExec.js";

const DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock";

interface ManagedContainerOwnership {
    container: Promise<Dockerode.Container>;
    apparmorProfile: string;
    owners: number;
    removal?: Promise<void>;
}

// Managed environments sharing a container name share one explicit ownership record. The last
// environment to release it removes it; containers selected with `config.container` never enter
// this map and therefore can never be removed by this package.
const managedContainerOwnership = new Map<string, ManagedContainerOwnership>();

/**
 * Resolves and caches the one container a Docker compute works inside.
 *
 * A configuration either attaches to a container the user already runs or starts a managed one from
 * a local image. Attaching verifies the container exists and is running; the managed path reuses a
 * container this package previously started for the session and otherwise creates it with the sandbox
 * requirements a restricted command needs. The resolved container is memoized so every filesystem
 * and shell call reaches the same one, and a transient failure clears the memo so the next call
 * retries rather than caching the error forever.
 */
export class DockerEnvironment {
    readonly config: DockerExecutionConfig;
    readonly #docker: Dockerode;
    readonly #managedContainerKey: string | undefined;
    readonly #managedContainerName: string | undefined;
    readonly #sessionId: string;
    #containerPromise: Promise<Dockerode.Container> | undefined;
    #supervisorBinaryPromise: Promise<string> | undefined;
    #managedOwnership: ManagedContainerOwnership | undefined;
    #releasePromise: Promise<void> | undefined;
    #released = false;

    constructor(
        config: DockerExecutionConfig,
        sessionId: string,
        docker: Dockerode = new Dockerode({
            socketPath: config.socketPath ?? DEFAULT_DOCKER_SOCKET,
        }),
    ) {
        this.config = config;
        this.#sessionId = sessionId;
        this.#docker = docker;
        this.#managedContainerName =
            config.container === undefined ? (config.name ?? `compute-${sessionId}`) : undefined;
        this.#managedContainerKey =
            this.#managedContainerName === undefined
                ? undefined
                : `${config.socketPath ?? DEFAULT_DOCKER_SOCKET}\0${this.#managedContainerName}`;
    }

    container(): Promise<Dockerode.Container> {
        if (this.#released) {
            return Promise.reject(new Error("The Docker environment has already been released."));
        }
        this.#containerPromise ??= this.#resolveContainer().catch((error: unknown) => {
            this.#containerPromise = undefined;
            throw error;
        });
        return this.#containerPromise;
    }

    /**
     * Returns the in-container supervisor path after proving that an attached container already
     * carries the required read-only mount. Managed containers install the mount at creation time;
     * an attached container cannot be repaired safely after it is running, so it fails closed.
     */
    supervisorBinary(): Promise<string> {
        if (this.#released) {
            return Promise.reject(new Error("The Docker environment has already been released."));
        }
        this.#supervisorBinaryPromise ??= this.#resolveSupervisorBinary().catch(
            (error: unknown) => {
                this.#supervisorBinaryPromise = undefined;
                throw error;
            },
        );
        return this.#supervisorBinaryPromise;
    }

    /**
     * Releases this environment's ownership without ever removing an explicitly attached
     * container. A managed container is removed only after the last environment sharing it leaves.
     */
    release(): Promise<void> {
        this.#releasePromise ??= this.#release();
        return this.#releasePromise;
    }

    async #release(): Promise<void> {
        this.#released = true;
        if (this.#managedContainerKey === undefined || this.#containerPromise === undefined) return;
        await this.#containerPromise.catch(() => undefined);
        const ownership = this.#managedOwnership;
        this.#managedOwnership = undefined;
        if (ownership === undefined) return;
        ownership.owners -= 1;
        if (ownership.owners > 0) return;

        const removal = ownership.container.then(async (container) => {
            await container.remove({ force: true });
        });
        ownership.removal = removal;
        try {
            await removal;
        } finally {
            if (managedContainerOwnership.get(this.#managedContainerKey) === ownership) {
                managedContainerOwnership.delete(this.#managedContainerKey);
            }
        }
    }

    async #resolveContainer(): Promise<Dockerode.Container> {
        if (this.config.container !== undefined) {
            const container = this.#docker.getContainer(this.config.container);
            const details = await container.inspect().catch((error: unknown) => {
                if (isDockerNotFoundError(error)) {
                    throw new Error(
                        `Docker container '${this.config.container}' was not found. Start it or update the Docker configuration.`,
                    );
                }
                throw error;
            });
            if (!details.State.Running) {
                throw new Error(
                    `Docker container '${this.config.container}' is not running. Start it before sending a message.`,
                );
            }
            return container;
        }

        return this.#acquireManagedContainer();
    }

    async #acquireManagedContainer(): Promise<Dockerode.Container> {
        const image = this.config.image;
        if (image === undefined) throw new Error("Docker execution requires a container or image.");
        const name = this.#managedContainerName!;
        const key = this.#managedContainerKey!;
        for (;;) {
            const activeOwnership = managedContainerOwnership.get(key);
            if (activeOwnership?.removal !== undefined) {
                await activeOwnership.removal.catch(() => undefined);
                if (this.#released) {
                    throw new Error("The Docker environment has already been released.");
                }
                continue;
            }
            if (
                activeOwnership !== undefined &&
                activeOwnership.apparmorProfile !== (this.config.apparmorProfile ?? "unconfined")
            ) {
                throw new Error(
                    "The managed container's AppArmor profile does not match the requested profile.",
                );
            }
            const ownership = activeOwnership ?? {
                container: this.#resolveManagedContainer(image, name),
                apparmorProfile: this.config.apparmorProfile ?? "unconfined",
                owners: 0,
            };
            if (activeOwnership === undefined) {
                managedContainerOwnership.set(key, ownership);
                void ownership.container.catch(() => {
                    if (managedContainerOwnership.get(key) === ownership) {
                        managedContainerOwnership.delete(key);
                    }
                });
            }
            ownership.owners += 1;
            this.#managedOwnership = ownership;
            return ownership.container;
        }
    }

    async #resolveManagedContainer(image: string, name: string): Promise<Dockerode.Container> {
        const existing = this.#docker.getContainer(name);
        const details = await existing.inspect().catch((error: unknown) => {
            if (isDockerNotFoundError(error)) return undefined;
            throw error;
        });
        if (details !== undefined) {
            if (
                details.Config.Labels?.["dev.agent-compute.managed"] !== "true" ||
                (this.config.name === undefined &&
                    details.Config.Labels?.["dev.agent-compute.session"] !== this.#sessionId)
            ) {
                throw new Error(
                    `Docker container name '${name}' is already in use by another container. Choose a different Docker container name.`,
                );
            }
            if (
                this.config.apparmorProfile !== undefined &&
                details.AppArmorProfile !== this.config.apparmorProfile
            ) {
                throw new Error(
                    "The managed container's AppArmor profile does not match the requested profile.",
                );
            }
            if (!details.State.Running) await existing.start();
            return existing;
        }
        return this.#createManagedContainer(image, name);
    }

    async #createManagedContainer(image: string, name: string): Promise<Dockerode.Container> {
        const supervisorBinary = this.#resolveSupervisorBinaryForHost();
        const requestedMounts = this.config.mounts ?? [];
        if (
            requestedMounts.some(
                (mount) => posix.normalize(mount.target) === DOCKER_SUPERVISOR_PATH,
            )
        ) {
            throw new Error(
                `Docker mount target '${DOCKER_SUPERVISOR_PATH}' is reserved for the Happy agent supervisor.`,
            );
        }
        const container = await this.#docker
            .createContainer({
                name,
                Image: image,
                Entrypoint: ["/bin/sh", "-c"],
                Cmd: ["trap : TERM INT; while :; do sleep 2073600; done"],
                Env: Object.entries(this.config.environment ?? {}).map(
                    ([key, value]) => `${key}=${value}`,
                ),
                Labels: {
                    "dev.agent-compute.managed": "true",
                    "dev.agent-compute.session": this.#sessionId,
                },
                OpenStdin: false,
                Tty: false,
                WorkingDir: this.config.workingDirectory,
                HostConfig: {
                    Mounts: [
                        ...requestedMounts.map((mount) => ({
                            Type: "bind" as const,
                            Source: mount.source,
                            Target: mount.target,
                            ReadOnly: mount.readOnly ?? false,
                        })),
                        {
                            Type: "bind" as const,
                            Source: supervisorBinary,
                            Target: DOCKER_SUPERVISOR_PATH,
                            ReadOnly: true,
                        },
                    ],
                    // Restricted commands create their own user, PID, mount, and network
                    // namespaces with the native supervisor. Docker's outer seccomp, AppArmor,
                    // and protected system paths otherwise block setup before the supervisor can
                    // apply its narrower filter and mounts. The Docker CLI's
                    // `systempaths=unconfined` shorthand maps to these two empty path arrays.
                    SecurityOpt: [
                        "seccomp=unconfined",
                        `apparmor=${this.config.apparmorProfile ?? "unconfined"}`,
                    ],
                    MaskedPaths: [],
                    ReadonlyPaths: [],
                },
            })
            .catch((error: unknown) => {
                throw new Error(
                    `Could not create a Docker container from local image '${image}'. Make sure the image exists and the mount paths are available: ${errorToMessage(error)}`,
                );
            });
        await container.start().catch(async (error: unknown) => {
            await container.remove({ force: true }).catch(() => undefined);
            throw new Error(`Could not start Docker image '${image}': ${errorToMessage(error)}`);
        });
        return container;
    }

    async #resolveSupervisorBinary(): Promise<string> {
        const container = await this.container();
        const details = await container.inspect();
        const architecture = resolveConfiguredLinuxArchitecture(this.config.architecture);
        const expectedSource = this.#resolveSupervisorBinaryForHost();
        const mount = details.Mounts?.find(
            (candidate) => candidate.Destination === DOCKER_SUPERVISOR_PATH,
        );
        if (
            mount === undefined ||
            mount.Type !== "bind" ||
            mount.RW !== false ||
            typeof mount.Source !== "string" ||
            mount.Source !== expectedSource
        ) {
            throw new Error(
                `Restricted Docker commands require a read-only bind mount at ${DOCKER_SUPERVISOR_PATH}. ` +
                    `Restart the container with the ${architecture} static Linux supervisor mounted directly from ${expectedSource}.`,
            );
        }
        const result = await runDockerExec(container, [
            "/bin/sh",
            "-c",
            [
                "path=$1",
                "expected=$2",
                '[ -x "$path" ] || exit 40',
                '"$path" --policy "$3" -- /bin/sh -c "exit 0" >/dev/null 2>&1',
                "status=$?",
                '[ "$status" -eq 0 ] || exit 41',
                "machine=$(uname -m 2>/dev/null) || exit 42",
                'case "$expected:$machine" in',
                "  x64:x86_64|x64:amd64|amd64:x86_64|amd64:amd64|x86_64:x86_64|x86_64:amd64|aarch64:aarch64|aarch64:arm64|arm64:aarch64|arm64:arm64) exit 0 ;;",
                "  *) exit 43 ;;",
                "esac",
            ].join("\n"),
            "happy-agent-supervisor-check",
            DOCKER_SUPERVISOR_PATH,
            architecture,
            '{"mode":"full_access","network":{"egress":true,"localBinding":true}}',
        ]);
        if (result.exitCode === 40) {
            throw new Error(
                `Restricted Docker commands require an executable supervisor at ${DOCKER_SUPERVISOR_PATH}.`,
            );
        }
        if (result.exitCode !== 0) {
            throw new Error(
                `Restricted Docker commands require a ${architecture} Linux supervisor at ${DOCKER_SUPERVISOR_PATH}; ` +
                    "the attached read-only mount is missing or targets a different architecture.",
            );
        }
        return DOCKER_SUPERVISOR_PATH;
    }

    #resolveSupervisorBinaryForHost(): string {
        const architecture = resolveConfiguredLinuxArchitecture(this.config.architecture);
        try {
            return resolveLinuxSupervisorBinary(architecture);
        } catch (error) {
            throw new Error(
                `Could not prepare the Linux supervisor for Docker architecture '${architecture}': ${errorToMessage(error)}`,
            );
        }
    }
}

function resolveConfiguredLinuxArchitecture(
    configured: LinuxSupervisorArchitecture | undefined,
): LinuxSupervisorArchitecture {
    if (configured !== undefined) return configured;
    if (process.arch === "arm64") return "arm64";
    if (process.arch === "x64") return "x64";
    return process.arch as LinuxSupervisorArchitecture;
}
