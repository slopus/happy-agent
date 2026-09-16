import { PassThrough } from "node:stream";

import type Dockerode from "dockerode";
import { resolveLinuxSupervisorBinary } from "@slopus/happy-agent-supervisor";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DockerEnvironment } from "../../sources/docker/DockerEnvironment.js";
import { DOCKER_SUPERVISOR_PATH } from "../../sources/docker/impl/createDockerSupervisorCommand.js";

describe("DockerEnvironment", () => {
    const inspect = vi.fn();
    const docker = {
        getContainer: vi.fn(() => ({ inspect })),
    } as unknown as Dockerode;

    beforeEach(() => {
        inspect.mockReset();
    });

    it("retries container resolution after a transient failure", async () => {
        inspect
            .mockRejectedValueOnce(new Error("Docker socket was temporarily unavailable."))
            .mockResolvedValueOnce({ State: { Running: true } });
        const environment = new DockerEnvironment(
            { container: "dev", workingDirectory: "/workspace" },
            "session",
            docker,
        );

        await expect(environment.container()).rejects.toThrow("temporarily unavailable");
        await expect(environment.container()).resolves.toBeDefined();
        expect(inspect).toHaveBeenCalledTimes(2);
    });

    it("reports a missing container as a clear, actionable error", async () => {
        inspect.mockRejectedValue({ statusCode: 404 });
        const environment = new DockerEnvironment(
            { container: "gone", workingDirectory: "/workspace" },
            "session",
            docker,
        );

        await expect(environment.container()).rejects.toThrow(
            "Docker container 'gone' was not found.",
        );
    });

    it("removes a managed container when its owner releases it", async () => {
        const created = {
            remove: vi.fn().mockResolvedValue(undefined),
            start: vi.fn().mockResolvedValue(undefined),
        } as unknown as Dockerode.Container;
        const createContainer = vi.fn().mockResolvedValue(created);
        const managedDocker = {
            createContainer,
            getContainer: vi.fn(() => ({
                inspect: vi.fn().mockRejectedValue({ statusCode: 404 }),
            })),
        } as unknown as Dockerode;
        const environment = new DockerEnvironment(
            {
                image: "compute-dev:latest",
                name: "managed-release-test",
                architecture: "arm64",
                workingDirectory: "/workspace",
            },
            "session-managed",
            managedDocker,
        );

        await environment.container();
        expect(createContainer).toHaveBeenCalledWith(
            expect.objectContaining({
                HostConfig: expect.objectContaining({
                    Mounts: expect.arrayContaining([
                        expect.objectContaining({
                            ReadOnly: true,
                            Source: resolveLinuxSupervisorBinary("arm64"),
                            Target: DOCKER_SUPERVISOR_PATH,
                        }),
                    ]),
                    SecurityOpt: ["seccomp=unconfined", "apparmor=unconfined"],
                    MaskedPaths: [],
                    ReadonlyPaths: [],
                }),
            }),
        );
        await environment.release();

        expect(created.remove).toHaveBeenCalledOnce();
        expect(created.remove).toHaveBeenCalledWith({ force: true });
    });

    it("never removes a container the caller attached to", async () => {
        const attached = {
            inspect: vi.fn().mockResolvedValue({ State: { Running: true } }),
            remove: vi.fn(),
        } as unknown as Dockerode.Container;
        const attachedDocker = {
            getContainer: vi.fn(() => attached),
        } as unknown as Dockerode;
        const environment = new DockerEnvironment(
            { container: "developer-container", workingDirectory: "/workspace" },
            "session-attached",
            attachedDocker,
        );

        await environment.container();
        await environment.release();

        expect(attached.remove).not.toHaveBeenCalled();
    });

    it("passes a configured AppArmor profile to Docker without installing it", async () => {
        const created = { start: vi.fn(), remove: vi.fn() };
        created.start.mockResolvedValue(undefined);
        created.remove.mockResolvedValue(undefined);
        const createContainer = vi.fn().mockResolvedValue(created);
        const environment = new DockerEnvironment(
            {
                image: "compute-dev:latest",
                name: "managed-apparmor-test",
                workingDirectory: "/workspace",
                apparmorProfile: "happy-compute-tests",
            },
            "session-apparmor",
            {
                createContainer,
                getContainer: vi.fn(() => ({
                    inspect: vi.fn().mockRejectedValue({ statusCode: 404 }),
                })),
            } as unknown as Dockerode,
        );
        try {
            await environment.container();
            expect(createContainer).toHaveBeenCalledWith(
                expect.objectContaining({
                    HostConfig: expect.objectContaining({
                        SecurityOpt: ["seccomp=unconfined", "apparmor=happy-compute-tests"],
                    }),
                }),
            );
        } finally {
            await environment.release();
        }
    });

    it("refuses to reuse a managed container with a different requested AppArmor profile", async () => {
        const start = vi.fn();
        const environment = new DockerEnvironment(
            {
                image: "compute-dev:latest",
                name: "managed-apparmor-mismatch-test",
                workingDirectory: "/workspace",
                apparmorProfile: "happy-compute-tests",
            },
            "session-apparmor-mismatch",
            {
                getContainer: vi.fn(() => ({
                    inspect: vi.fn().mockResolvedValue({
                        Config: { Labels: { "dev.agent-compute.managed": "true" } },
                        State: { Running: false },
                        AppArmorProfile: "unconfined",
                    }),
                    start,
                })),
            } as unknown as Dockerode,
        );
        await expect(environment.container()).rejects.toThrow("AppArmor profile does not match");
        expect(start).not.toHaveBeenCalled();
        await expect(environment.release()).resolves.toBeUndefined();
    });

    it("fails closed for an attached container without the read-only supervisor mount", async () => {
        const attached = {
            inspect: vi.fn().mockResolvedValue({
                Config: { Env: [] },
                Mounts: [],
                State: { Running: true },
            }),
        } as unknown as Dockerode.Container;
        const attachedDocker = {
            getContainer: vi.fn(() => attached),
        } as unknown as Dockerode;
        const environment = new DockerEnvironment(
            { container: "developer-container", workingDirectory: "/workspace" },
            "session-attached-restricted",
            attachedDocker,
        );

        await expect(environment.supervisorBinary()).rejects.toThrow(
            `read-only bind mount at ${DOCKER_SUPERVISOR_PATH}`,
        );
    });

    it("probes an attached supervisor mount for the configured Linux architecture", async () => {
        const exec = createSuccessfulExec();
        const attached = {
            exec: vi.fn().mockResolvedValue(exec),
            inspect: vi.fn().mockResolvedValue({
                Mounts: [
                    {
                        Destination: DOCKER_SUPERVISOR_PATH,
                        RW: false,
                        Source: resolveLinuxSupervisorBinary("amd64"),
                        Type: "bind",
                    },
                ],
                State: { Running: true },
            }),
            modem: createDockerModem(),
        } as unknown as Dockerode.Container;
        const attachedDocker = {
            getContainer: vi.fn(() => attached),
        } as unknown as Dockerode;
        const environment = new DockerEnvironment(
            {
                architecture: "amd64",
                container: "developer-container",
                workingDirectory: "/workspace",
            },
            "session-attached-architecture",
            attachedDocker,
        );

        await expect(environment.supervisorBinary()).resolves.toBe(DOCKER_SUPERVISOR_PATH);
        expect((attached.exec as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].Cmd).toEqual([
            "/bin/sh",
            "-c",
            expect.stringContaining('--policy "$3"'),
            "happy-agent-supervisor-check",
            DOCKER_SUPERVISOR_PATH,
            "amd64",
            '{"mode":"full_access","network":{"egress":true,"localBinding":true}}',
        ]);
    });

    it("rejects an attached read-only executable that is not the installed NPM artifact", async () => {
        const attached = {
            inspect: vi.fn().mockResolvedValue({
                Mounts: [
                    {
                        Destination: DOCKER_SUPERVISOR_PATH,
                        RW: false,
                        Source: "/host/tools/fake-supervisor",
                        Type: "bind",
                    },
                ],
                State: { Running: true },
            }),
        } as unknown as Dockerode.Container;
        const attachedDocker = {
            getContainer: vi.fn(() => attached),
        } as unknown as Dockerode;
        const environment = new DockerEnvironment(
            {
                architecture: "arm64",
                container: "developer-container",
                workingDirectory: "/workspace",
            },
            "session-attached-fake-supervisor",
            attachedDocker,
        );

        await expect(environment.supervisorBinary()).rejects.toThrow(
            `mounted directly from ${resolveLinuxSupervisorBinary("arm64")}`,
        );
    });

    it("coordinates concurrent creation of one shared managed container", async () => {
        const missing = { statusCode: 404 };
        const created = {
            remove: vi.fn().mockResolvedValue(undefined),
            start: vi.fn().mockResolvedValue(undefined),
        } as unknown as Dockerode.Container;
        const createContainer = vi.fn(async () => {
            await Promise.resolve();
            return created;
        });
        const sharedDocker = {
            createContainer,
            getContainer: vi.fn(() => ({
                inspect: vi.fn().mockRejectedValue(missing),
            })),
        } as unknown as Dockerode;
        const config = {
            image: "compute-dev:latest",
            name: "compute-workspace-1",
            workingDirectory: "/workspace",
        };
        const first = new DockerEnvironment(config, "session-1", sharedDocker);
        const second = new DockerEnvironment(config, "session-2", sharedDocker);

        await expect(Promise.all([first.container(), second.container()])).resolves.toEqual([
            created,
            created,
        ]);
        expect(createContainer).toHaveBeenCalledTimes(1);
        expect(created.start).toHaveBeenCalledTimes(1);

        await first.release();
        expect(created.remove).not.toHaveBeenCalled();

        await second.release();
        expect(created.remove).toHaveBeenCalledOnce();
    });
});

function createSuccessfulExec(): Dockerode.Exec {
    const stream = new PassThrough();
    const exec = {
        inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
        start: vi.fn(async () => {
            setImmediate(() => stream.end());
            return stream;
        }),
    };
    return exec as unknown as Dockerode.Exec;
}

function createDockerModem(): Dockerode["modem"] {
    return {
        demuxStream(
            source: NodeJS.ReadableStream,
            stdout: NodeJS.WritableStream,
            stderr: NodeJS.WritableStream,
        ) {
            source.on("data", (chunk) => {
                stdout.write(chunk);
                stderr.write(chunk);
            });
            source.once("end", () => {
                stdout.end();
                stderr.end();
            });
        },
    } as unknown as Dockerode["modem"];
}
