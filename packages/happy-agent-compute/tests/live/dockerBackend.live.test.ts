import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Dockerode from "dockerode";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Compute } from "../../sources/Compute.js";
import { computePermissions } from "../../sources/ComputePermissions.js";
import { createDockerCompute } from "../../sources/docker/createDockerCompute.js";

const LIVE = process.env.HAPPY_AGENT_COMPUTE_LIVE_TEST === "1";
const describeLive = LIVE ? describe : describe.skip;
const itOnNativeLinux = process.platform === "linux" ? it : it.skip;
const image = process.env.HAPPY_AGENT_COMPUTE_DOCKER_IMAGE ?? "happy-terminal-gym:local";
const docker = new Dockerode();
const ctx: Context = createRootContext().named("happy-agent-compute-docker-live-test");
const computes = new Set<Compute>();
const temporaryDirectories = new Set<string>();
const cleanupContainers = new Set<string>();

describeLive("live Docker compute boundary", () => {
    beforeAll(async () => {
        try {
            await docker.ping();
        } catch (error) {
            throw new Error(
                `HAPPY_AGENT_COMPUTE_LIVE_TEST=1 was set, but the Docker daemon is unavailable: ${errorMessage(error)}`,
            );
        }
        try {
            await docker.getImage(image).inspect();
        } catch (error) {
            throw new Error(
                `HAPPY_AGENT_COMPUTE_LIVE_TEST=1 requires the local image '${image}': ${errorMessage(error)}`,
            );
        }
    }, 30_000);

    afterEach(async () => {
        await Promise.all([...computes].map((compute) => compute.dispose(ctx)));
        computes.clear();
        await Promise.all(
            [...cleanupContainers].map((name) =>
                docker
                    .getContainer(name)
                    .remove({ force: true })
                    .catch(() => undefined),
            ),
        );
        cleanupContainers.clear();
        await Promise.all(
            [...temporaryDirectories].map((path) => rm(path, { force: true, recursive: true })),
        );
        temporaryDirectories.clear();
    });

    it("contains a restricted command while preserving workspace writes", async () => {
        const { compute } = await managedCompute();
        const fullAccess = computePermissions("full_access");
        const workspaceWrite = computePermissions("workspace_write");

        const precondition = await compute.shell.run({
            command:
                "printf precondition > /home/rig/live-precondition && rm /home/rig/live-precondition",
            permissions: fullAccess,
        });
        expect(precondition.exitCode).toBe(0);

        const result = await compute.shell.run({
            command: [
                "printf inside > /workspace/inside.txt",
                "printf escaped > /home/rig/outside.txt",
            ].join("\n"),
            permissions: workspaceWrite,
        });

        expect(result.exitCode).not.toBe(0);
        await expect(compute.fs.readFile(fullAccess, "/workspace/inside.txt")).resolves.toBe(
            "inside",
        );
        await expect(compute.fs.exists(fullAccess, "/home/rig/outside.txt")).resolves.toBe(false);
    }, 60_000);

    it("atomically refuses a final-component symlink during a live swap race", async () => {
        const { compute } = await managedCompute();
        const fullAccess = computePermissions("full_access");
        const sessionId = await compute.shell.startSession({
            command: [
                "set -eu",
                "mkdir -p /workspace/race",
                "chmod 0777 /workspace/race",
                "printf secret-live-value > /home/rig/secret.txt",
                "printf safe > /workspace/race/candidate",
                "touch /workspace/race/ready",
                "while [ ! -e /workspace/race/stop ]; do",
                "  ln -sfn /home/rig/secret.txt /workspace/race/next",
                "  mv -f /workspace/race/next /workspace/race/candidate",
                "  printf safe > /workspace/race/next",
                "  mv -f /workspace/race/next /workspace/race/candidate",
                "done",
            ].join("\n"),
            permissions: fullAccess,
        });

        await vi.waitFor(
            async () => {
                await expect(compute.fs.exists(fullAccess, "/workspace/race/ready")).resolves.toBe(
                    true,
                );
            },
            { timeout: 10_000 },
        );

        let regularReads = 0;
        let refusedLinks = 0;
        for (let index = 0; index < 150; index += 1) {
            let content: string | undefined;
            try {
                content = Buffer.from(
                    await compute.fs.readFileBuffer(fullAccess, "/workspace/race/candidate", {
                        noFollow: true,
                    }),
                ).toString("utf8");
            } catch (error) {
                expect(errorMessage(error)).toMatch(
                    /symbolic link|not a regular file|invalid archive/u,
                );
                refusedLinks += 1;
                continue;
            }
            expect(content).toBe("safe");
            regularReads += 1;
        }
        expect(regularReads).toBeGreaterThan(0);
        expect(refusedLinks).toBeGreaterThan(0);

        await compute.fs.writeFile(fullAccess, "/workspace/race/stop", "");
        await vi.waitFor(
            async () => {
                await expect(
                    compute.shell.readSession(sessionId, { peek: true }),
                ).resolves.toMatchObject({ status: "completed" });
            },
            { timeout: 10_000 },
        );
    }, 60_000);

    // The native supervisor's egress proxy runs inside the container. Docker Desktop does not
    // provide the same Linux namespace behavior as a native Linux daemon, so this case stays in
    // the native-Linux lane that the release runs.
    itOnNativeLinux(
        "allows and denies real egress through the native supervisor",
        async () => {
            const { compute } = await managedCompute();
            const request = proxyRequestCommand("example.com");
            const allowed = await compute.shell.run({
                command: request,
                permissions: computePermissions("workspace_write", {
                    network: {
                        egress: true,
                        allowedHosts: ["example.com"],
                        localBinding: false,
                    },
                }),
                timeoutMs: 20_000,
            });
            expect(allowed.exitCode, JSON.stringify(allowed)).toBe(0);
            expect(allowed.stdout).toMatch(/^status:[1-5]\d\d$/mu);

            const denied = await compute.shell.run({
                command: request,
                permissions: computePermissions("workspace_write", {
                    network: {
                        egress: true,
                        allowedHosts: ["example.org"],
                        localBinding: false,
                    },
                }),
                timeoutMs: 20_000,
            });
            expect(denied.exitCode, JSON.stringify(denied)).not.toBe(0);
        },
        90_000,
    );

    it("marks a timed-out session without killing the container process", async () => {
        const { compute } = await managedCompute();
        const permissions = computePermissions("full_access");
        const sessionId = await compute.shell.startSession({
            command: [
                "printf started > /workspace/timeout-started",
                "while [ ! -e /workspace/release-timeout ]; do :; done",
                "printf survived > /workspace/timeout-survived",
            ].join("\n"),
            permissions,
            timeoutMs: 10,
        });

        await vi.waitFor(
            async () => {
                await expect(
                    compute.fs.exists(permissions, "/workspace/timeout-started"),
                ).resolves.toBe(true);
                await expect(
                    compute.shell.readSession(sessionId, { peek: true }),
                ).resolves.toMatchObject({ status: "running", timedOut: true });
            },
            { timeout: 10_000 },
        );

        await compute.fs.writeFile(permissions, "/workspace/release-timeout", "");
        await vi.waitFor(
            async () => {
                await expect(
                    compute.shell.readSession(sessionId, { peek: true }),
                ).resolves.toMatchObject({ status: "completed", timedOut: true });
                await expect(
                    compute.fs.readFile(permissions, "/workspace/timeout-survived"),
                ).resolves.toBe("survived");
            },
            { timeout: 10_000 },
        );
    }, 60_000);

    it("removes a managed container on disposal", async () => {
        const name = `happy-compute-managed-live-${randomUUID()}`;
        const { compute } = await managedCompute(name);
        await compute.fs.exists(computePermissions("full_access"), "/workspace");
        await expect(docker.getContainer(name).inspect()).resolves.toMatchObject({
            State: { Running: true },
        });

        await compute.dispose(ctx);
        computes.delete(compute);

        await expect(docker.getContainer(name).inspect()).rejects.toMatchObject({
            statusCode: 404,
        });
    }, 60_000);

    it("leaves an explicitly attached container running on disposal", async () => {
        const name = `happy-compute-attached-live-${randomUUID()}`;
        cleanupContainers.add(name);
        const container = await docker.createContainer({
            name,
            Image: image,
            Entrypoint: ["/bin/sh", "-c"],
            Cmd: ["trap : TERM INT; while :; do sleep 3600; done"],
            HostConfig: {
                SecurityOpt: ["seccomp=unconfined", "apparmor=unconfined"],
                MaskedPaths: [],
                ReadonlyPaths: [],
            },
            WorkingDir: "/workspace",
        });
        await container.start();
        const compute = createDockerCompute({
            client: docker,
            docker: { container: name, workingDirectory: "/workspace" },
            sessionId: randomUUID(),
        });
        computes.add(compute);
        await compute.fs.exists(computePermissions("full_access"), "/workspace");

        await compute.dispose(ctx);
        computes.delete(compute);

        await expect(container.inspect()).resolves.toMatchObject({ State: { Running: true } });
    }, 60_000);
});

async function managedCompute(name = `happy-compute-live-${randomUUID()}`): Promise<{
    compute: Compute;
    hostWorkspace: string;
}> {
    const hostWorkspace = await mkdtemp(join(tmpdir(), "happy-compute-docker-live-"));
    temporaryDirectories.add(hostWorkspace);
    await chmod(hostWorkspace, 0o777);
    const compute = createDockerCompute({
        client: docker,
        docker: {
            image,
            mounts: [{ source: hostWorkspace, target: "/workspace" }],
            name,
            workingDirectory: "/workspace",
        },
        sessionId: randomUUID(),
    });
    computes.add(compute);
    return { compute, hostWorkspace };
}

function proxyRequestCommand(host: string): string {
    const script = [
        `fetch("https://${host}/", { signal: AbortSignal.timeout(15_000) })`,
        "  .then(async response => {",
        "    console.log(`status:${response.status}`);",
        "    await response.body?.cancel();",
        "    process.exit(response.status >= 100 && response.status <= 599 ? 0 : 25);",
        "  })",
        "  .catch(error => { console.error(error); process.exit(24); });",
    ].join("\n");
    return `node -e ${shellQuote(script)}`;
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
