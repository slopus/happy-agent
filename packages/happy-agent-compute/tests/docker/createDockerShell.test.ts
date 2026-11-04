import { PassThrough } from "node:stream";

import type Dockerode from "dockerode";
import { describe, expect, it, vi } from "vitest";

import { computePermissions } from "../../sources/ComputePermissions.js";
import type { ComputeSessionExit } from "../../sources/ComputeShell.js";
import { createDockerShell } from "../../sources/docker/createDockerShell.js";
import type { DockerEnvironment } from "../../sources/docker/DockerEnvironment.js";

// This whole suite runs without a Docker daemon: a fake container records the commands it is asked
// to run and hands back streams the test drives by hand, which is enough to exercise the session
// manager's timeout, delta, stop, interrupt, and exit-notification behaviour end to end.
const fullAccess = () => computePermissions("full_access");

describe("createDockerShell", () => {
    it("uses distinct pid files for shells sharing a container", async () => {
        const fake = createFakeDockerEnvironment();
        const first = createDockerShell(fake.environment);
        const second = createDockerShell(fake.environment);

        await first.startSession({ command: "sleep 10", permissions: fullAccess() });
        await second.startSession({ command: "sleep 10", permissions: fullAccess() });

        const pidFiles = fake.foregroundCommands.map((command) => command[4]);
        expect(pidFiles).toHaveLength(2);
        expect(new Set(pidFiles).size).toBe(2);

        for (const stream of fake.foregroundStreams) stream.end();
        await Promise.all([
            first.readSession(1, { waitMs: 1_000 }),
            second.readSession(1, { waitMs: 1_000 }),
        ]);
    });

    it("applies a two-minute default timeout to foreground runs", async () => {
        const fake = createFakeDockerEnvironment();
        const shell = createDockerShell(fake.environment);
        const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

        try {
            const resultPromise = shell.run({ command: "printf done", permissions: fullAccess() });
            await vi.waitFor(() => expect(fake.foregroundStreams).toHaveLength(1));

            expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 120_000)).toBe(true);
            fake.foregroundStreams[0]?.end();
            await expect(resultPromise).resolves.toMatchObject({ timedOut: false });
        } finally {
            timeoutSpy.mockRestore();
        }
    });

    it("leaves a session running and readable after its timeout", async () => {
        vi.useFakeTimers();
        try {
            const fake = createFakeDockerEnvironment();
            const shell = createDockerShell(fake.environment);
            await shell.startSession({
                command: "long-running command",
                permissions: fullAccess(),
                timeoutMs: 50,
            });

            await vi.advanceTimersByTimeAsync(50);
            fake.foregroundStreams[0]?.write("still running");

            await expect(shell.readSession(1)).resolves.toMatchObject({
                status: "running",
                stdout: expect.stringContaining("still running"),
                timedOut: true,
            });
            expect(fake.controlCommands).toEqual([]);

            fake.foregroundStreams[0]?.end();
            await vi.waitFor(async () =>
                expect(await shell.readSession(1)).toMatchObject({ status: "completed" }),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it.each(["run", "startSession"] as const)(
        "refuses a custom shell outside Full access through %s",
        async (operation) => {
            const fake = createFakeDockerEnvironment();
            const shell = createDockerShell(fake.environment);
            const permissions = computePermissions("workspace_write");

            const result =
                operation === "run"
                    ? shell.run({ command: "pwd", permissions, shell: "/bin/bash" })
                    : shell.startSession({ command: "pwd", permissions, shell: "/bin/bash" });
            await expect(result).rejects.toThrow(
                "Custom shells are available only in Full access mode.",
            );
            expect(fake.foregroundCommands).toEqual([]);
        },
    );

    it("captures one command's permissions independently from the caller's later choice", async () => {
        const fake = createFakeDockerEnvironment();
        const shell = createDockerShell(fake.environment);
        const permissions = fullAccess();
        const starting = shell.startSession({ command: "pwd", permissions });
        permissions.mode = "read_only";
        permissions.network.egress = false;
        permissions.network.localBinding = false;

        await expect(starting).resolves.toBe(1);
        expect(fake.foregroundCommands[0]).not.toContain("--unshare-net");
        expect(permissions.mode).toBe("read_only");

        fake.foregroundStreams[0]?.end();
        await shell.readSession(1, { waitMs: 1_000 });
    });

    it("finishes and reports an error when Docker exec inspection hangs", async () => {
        vi.useFakeTimers();
        try {
            const fake = createFakeDockerEnvironment(() => new Promise(() => {}));
            const shell = createDockerShell(fake.environment);
            await shell.startSession({
                command: "finish despite hung inspect",
                permissions: fullAccess(),
            });
            fake.foregroundStreams[0]?.end();

            await vi.advanceTimersByTimeAsync(10_000);

            await expect(shell.readSession(1)).resolves.toMatchObject({
                exitCode: null,
                status: "killed",
                stderr: expect.stringContaining("Timed out waiting for Docker command status."),
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it("keeps unread output deltas when capped buffers evict older bytes", async () => {
        const fake = createFakeDockerEnvironment();
        const shell = createDockerShell(fake.environment);
        await shell.startSession({
            command: "stream output",
            maxOutputBytes: 5,
            permissions: fullAccess(),
        });
        const stream = fake.foregroundStreams[0];
        stream?.write("abcde");

        await vi.waitFor(async () =>
            expect(await shell.readSession(1, { peek: true })).toMatchObject({
                stdoutDelta: "co\n... 14 bytes omitted ...\ncde",
                stdoutDeltaBytes: 19,
                stdoutDeltaOmittedBytes: 14,
            }),
        );
        await shell.readSession(1);
        stream?.write("fg");
        await vi.waitFor(async () =>
            expect(await shell.readSession(1)).toMatchObject({ stdoutDelta: "fg" }),
        );

        stream?.end();
        await shell.readSession(1, { waitMs: 1_000 });
    });

    it("sends SIGINT without completing the running session", async () => {
        const fake = createFakeDockerEnvironment();
        const shell = createDockerShell(fake.environment);
        await shell.startSession({ command: "interactive command", permissions: fullAccess() });

        await expect(shell.interruptSession?.(1)).resolves.toBe(true);

        expect(fake.controlCommands).toHaveLength(1);
        expect(fake.controlCommands[0]?.join(" ")).toContain("kill -INT");
        await expect(shell.readSession(1)).resolves.toMatchObject({ status: "running" });

        fake.foregroundStreams[0]?.end();
        await shell.readSession(1, { waitMs: 1_000 });
    });

    it("reports an unobserved background command exit", async () => {
        const fake = createFakeDockerEnvironment();
        const shell = createDockerShell(fake.environment);
        const exits: ComputeSessionExit[] = [];
        shell.setSessionExitListener?.((exit) => {
            exits.push(exit);
        });

        await shell.startSession({ command: "background command", permissions: fullAccess() });
        fake.foregroundStreams[0]?.end();

        await vi.waitFor(() =>
            expect(exits).toEqual([
                { command: "background command", exitCode: 0, sessionId: 1, status: "completed" },
            ]),
        );
    });

    it("does not report an exit a consuming reader is waiting to observe", async () => {
        const fake = createFakeDockerEnvironment();
        const shell = createDockerShell(fake.environment);
        const exits: ComputeSessionExit[] = [];
        shell.setSessionExitListener?.((exit) => {
            exits.push(exit);
        });

        await shell.startSession({ command: "observed command", permissions: fullAccess() });
        const reading = shell.readSession(1, { waitMs: 1_000 });
        fake.foregroundStreams[0]?.end();

        await expect(reading).resolves.toMatchObject({ status: "completed" });
        expect(exits).toEqual([]);
    });

    it("stops a command gracefully before forcing it after two seconds", async () => {
        const fake = createFakeDockerEnvironment();
        const shell = createDockerShell(fake.environment);
        const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
        try {
            await shell.startSession({ command: "background command", permissions: fullAccess() });
            await shell.killSession(1);

            expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 2_000)).toBe(true);
        } finally {
            timeoutSpy.mockRestore();
        }
    });

    it("handles container lookup failures while aborting a foreground run", async () => {
        const fake = createFakeDockerEnvironment();
        let containerRequests = 0;
        const environment = {
            config: { workingDirectory: "/workspace" },
            container: async () => {
                containerRequests += 1;
                if (containerRequests === 1) return fake.container;
                throw new Error("Docker socket unavailable during abort.");
            },
        } as unknown as DockerEnvironment;
        const shell = createDockerShell(environment);
        const controller = new AbortController();
        const resultPromise = shell.run({
            command: "sleep 10",
            permissions: fullAccess(),
            signal: controller.signal,
        });
        await vi.waitFor(() => expect(fake.foregroundStreams).toHaveLength(1));

        controller.abort();

        await expect(resultPromise).resolves.toMatchObject({
            stderr: "Docker socket unavailable during abort.",
        });
    });

    it("injects the session's base environment into every Docker exec", async () => {
        const fake = createFakeDockerEnvironment();
        const shell = createDockerShell(fake.environment, {
            baseEnvironment: {
                GIT_AUTHOR_EMAIL: "steve@example.com",
                GIT_AUTHOR_NAME: "Steve Korshakov",
            },
        });

        await shell.startSession({ command: "git-identity", permissions: fullAccess() });

        expect(fake.foregroundEnvironments[0]).toEqual([
            "GIT_AUTHOR_EMAIL=steve@example.com",
            "GIT_AUTHOR_NAME=Steve Korshakov",
        ]);
        fake.foregroundStreams[0]?.end();
        await shell.readSession(1, { waitMs: 1_000 });
    });

    it("refuses secret bundles and pseudo-terminals it cannot honour", async () => {
        const fake = createFakeDockerEnvironment();
        const shell = createDockerShell(fake.environment);

        await expect(
            shell.startSession({
                command: "use-secret",
                permissions: fullAccess(),
                secrets: ["service"],
            }),
        ).rejects.toThrow("cannot inject secret bundles");
        await expect(
            shell.startSession({
                command: "interactive",
                permissions: fullAccess(),
                tty: true,
            }),
        ).rejects.toThrow("does not run commands under a pseudo-terminal");
        expect(fake.foregroundCommands).toEqual([]);
    });

    it("cleans an absent project policy when native network translation rejects it", async () => {
        const bookkeepingCommands: string[][] = [];
        const container = createBookkeepingDockerContainer(bookkeepingCommands);
        const environment = {
            config: { workingDirectory: "/workspace" },
            container: async () => container,
            supervisorBinary: async () => "/tools/happy-agent-sandbox",
        } as unknown as DockerEnvironment;
        const shell = createDockerShell(environment, {
            hostPolicy: { networkPolicyFiles: ["agent-policy.toml"] },
            parseNetworkConfig: () => ({ allowedDomains: ["example.com"] }),
        });

        await expect(
            shell.startSession({
                command: "true",
                permissions: computePermissions("workspace_write", {
                    network: { egress: true, localBinding: false },
                }),
            }),
        ).rejects.toThrow("per-domain ports are not supported");
        expect(bookkeepingCommands.some((command) => command[3] === "compute-policy-cleanup")).toBe(
            true,
        );
    });

    it("keeps a deny-all project intersection valid when the command narrows ports", async () => {
        const bookkeepingCommands: string[][] = [];
        const foregroundStreams: PassThrough[] = [];
        const container = createBookkeepingDockerContainer(
            bookkeepingCommands,
            foregroundStreams,
            false,
        );
        const environment = {
            config: { workingDirectory: "/workspace" },
            container: async () => container,
            supervisorBinary: async () => "/tools/happy-agent-sandbox",
        } as unknown as DockerEnvironment;
        const shell = createDockerShell(environment, {
            hostPolicy: { networkPolicyFiles: ["agent-policy.toml"] },
            parseNetworkConfig: () => ({ allowedDomains: [] }),
        });

        await shell.startSession({
            command: "true",
            permissions: computePermissions("workspace_write", {
                network: {
                    egress: true,
                    allowedHosts: ["example.com"],
                    allowedPorts: [443],
                    deniedHosts: ["uploads.example.com"],
                    localBinding: false,
                },
            }),
        });

        const command = bookkeepingCommands.find((candidate) => candidate[3] === "compute-command");
        expect((readSupervisorPolicy(command!) as { network: unknown }).network).toEqual({
            egress: true,
            localBinding: false,
            outgoingProxy: { frontEnds: ["http", "socks5"] },
        });
    });

    it("keeps an absent project policy reserved across shells sharing a container", async () => {
        const bookkeepingCommands: string[][] = [];
        const foregroundStreams: PassThrough[] = [];
        const container = createBookkeepingDockerContainer(
            bookkeepingCommands,
            foregroundStreams,
            false,
        );
        const environment = {
            config: { container: "shared", workingDirectory: "/workspace" },
            container: async () => container,
            supervisorBinary: async () => "/tools/happy-agent-sandbox",
        } as unknown as DockerEnvironment;
        const options = {
            hostPolicy: { networkPolicyFiles: ["agent-policy.toml"] },
            parseNetworkConfig: () => undefined,
        };
        const first = createDockerShell(environment, options);
        const second = createDockerShell(environment, options);

        await first.startSession({
            command: "first",
            permissions: computePermissions("workspace_write"),
        });
        await second.startSession({
            command: "second",
            permissions: computePermissions("workspace_write"),
        });

        const foregroundCommands = bookkeepingCommands.filter(
            (command) => command[3] === "compute-command",
        );
        const firstPolicy = readSupervisorPolicy(foregroundCommands[0]!) as {
            deniedWritePaths: string[];
        };
        const secondPolicy = readSupervisorPolicy(foregroundCommands[1]!) as {
            deniedWritePaths: string[];
        };
        const sharedMarker = firstPolicy.deniedWritePaths.find((path) =>
            path.startsWith("/workspace/.policy-"),
        );
        expect(sharedMarker).toBeDefined();
        expect(secondPolicy.deniedWritePaths).toContain(sharedMarker);

        const cleanupCount = () =>
            bookkeepingCommands.filter((command) => command[3] === "compute-policy-cleanup").length;
        expect(cleanupCount()).toBe(0);

        foregroundStreams[0]?.end();
        await first.readSession(1, { waitMs: 1_000 });
        expect(cleanupCount()).toBe(0);

        foregroundStreams[1]?.end();
        await second.readSession(1, { waitMs: 1_000 });
        expect(cleanupCount()).toBe(1);
    });

    it("does not let a concurrent policy-parser failure remove another command's placeholder", async () => {
        const bookkeepingCommands: string[][] = [];
        const foregroundStreams: PassThrough[] = [];
        const container = createBookkeepingDockerContainer(
            bookkeepingCommands,
            foregroundStreams,
            false,
        );
        const environment = {
            config: { container: "shared-parser", workingDirectory: "/workspace" },
            container: async () => container,
            supervisorBinary: async () => "/tools/happy-agent-sandbox",
        } as unknown as DockerEnvironment;
        let parseCalls = 0;
        const options = {
            hostPolicy: { networkPolicyFiles: ["agent-policy.toml"] },
            parseNetworkConfig: () => {
                parseCalls += 1;
                if (parseCalls === 2) throw new Error("policy parser failed");
                return undefined;
            },
        };
        const first = createDockerShell(environment, options);
        const second = createDockerShell(environment, options);

        await first.startSession({
            command: "first",
            permissions: computePermissions("workspace_write"),
        });
        await expect(
            second.startSession({
                command: "second",
                permissions: computePermissions("workspace_write"),
            }),
        ).rejects.toThrow("policy parser failed");

        const cleanupCount = () =>
            bookkeepingCommands.filter((command) => command[3] === "compute-policy-cleanup").length;
        expect(cleanupCount()).toBe(0);

        foregroundStreams[0]?.end();
        await first.readSession(1, { waitMs: 1_000 });
        expect(cleanupCount()).toBe(1);
    });
});

function createFakeDockerEnvironment(
    inspectForeground: () => Promise<{ ExitCode: number | null }> = async () => ({ ExitCode: 0 }),
    hooks: {
        afterForegroundExec?: () => void;
        beforeForegroundStart?: () => void;
    } = {},
): {
    container: Dockerode.Container;
    controlCommands: string[][];
    environment: DockerEnvironment;
    foregroundCommands: string[][];
    foregroundEnvironments: string[][];
    foregroundStreams: PassThrough[];
} {
    const controlCommands: string[][] = [];
    const foregroundCommands: string[][] = [];
    const foregroundEnvironments: string[][] = [];
    const foregroundStreams: PassThrough[] = [];
    const container = {
        async exec(options: { AttachStdin?: boolean; Cmd?: string[]; Env?: string[] }) {
            const stream = new PassThrough();
            if (options.AttachStdin === true) {
                foregroundCommands.push(options.Cmd ?? []);
                foregroundEnvironments.push(options.Env ?? []);
                foregroundStreams.push(stream);
                hooks.afterForegroundExec?.();
            } else {
                controlCommands.push(options.Cmd ?? []);
                queueMicrotask(() => stream.end());
            }
            return {
                inspect:
                    options.AttachStdin === true
                        ? inspectForeground
                        : async () => ({ ExitCode: 0 }),
                start: async () => {
                    if (options.AttachStdin === true) hooks.beforeForegroundStart?.();
                    return stream;
                },
            };
        },
        modem: {
            demuxStream(
                stream: NodeJS.ReadableStream,
                stdout: NodeJS.WritableStream,
                _stderr: NodeJS.WritableStream,
            ) {
                stream.pipe(stdout);
            },
        },
    } as unknown as Dockerode.Container;
    return {
        container,
        controlCommands,
        environment: {
            config: { workingDirectory: "/workspace" },
            container: async () => container,
        } as unknown as DockerEnvironment,
        foregroundCommands,
        foregroundEnvironments,
        foregroundStreams,
    };
}

function createBookkeepingDockerContainer(
    commands: string[][],
    foregroundStreams: PassThrough[] = [],
    autoEndForeground = true,
): Dockerode.Container {
    return {
        async exec(options: { AttachStdin?: boolean; Cmd?: string[] }) {
            const command = options.Cmd ?? [];
            commands.push(command);
            const stream = new PassThrough();
            if (options.AttachStdin === true) {
                foregroundStreams.push(stream);
            }
            const output =
                command[3] === "compute-policy"
                    ? Buffer.from("PF\0\0")
                    : command[3] === "compute-permission-paths"
                      ? Buffer.from(`${"1\n".repeat(Math.max(0, command.length - 4))}`)
                      : command[3] === "compute-denied-write-paths"
                        ? Buffer.from(`${"0\n".repeat(Math.max(0, command.length - 4))}`)
                        : Buffer.alloc(0);
            return {
                inspect: async () => ({ ExitCode: 0 }),
                start: async () => {
                    if (options.AttachStdin === true && !autoEndForeground) return stream;
                    setImmediate(() => {
                        if (output.length > 0) stream.write(output);
                        stream.end();
                    });
                    return stream;
                },
            };
        },
        modem: {
            demuxStream(
                stream: NodeJS.ReadableStream,
                stdout: NodeJS.WritableStream,
                stderr: NodeJS.WritableStream,
            ) {
                stream.on("data", (chunk) => stdout.write(chunk));
                stream.once("end", () => {
                    stdout.end();
                    stderr.end();
                });
            },
        },
    } as unknown as Dockerode.Container;
}

function readSupervisorPolicy(command: readonly string[]): unknown {
    const policyIndex = command.indexOf("--policy");
    expect(policyIndex).toBeGreaterThanOrEqual(0);
    return JSON.parse(command[policyIndex + 1]!);
}
