import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const docker = vi.hoisted(() => ({
    execFile: vi.fn(async (_program: string, _arguments: readonly string[]) => ({
        stdout: "false\n",
        stderr: "",
    })),
}));
vi.mock("node:child_process", () => ({ execFile: docker.execFile }));
vi.mock("node:util", () => ({ promisify: (operation: unknown) => operation }));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), chmod: vi.fn(), stat: vi.fn() }));

import { acquireSharedDockerRunner } from "./sharedDockerRunner.js";

beforeEach(() => {
    docker.execFile.mockClear();
});
afterEach(() => {
    vi.unstubAllEnvs();
});

describe("shared Docker runner AppArmor selection", () => {
    it("keeps the existing default without an explicit profile", async () => {
        vi.stubEnv("HAPPY_TERMINAL_GYM_DOCKER_APPARMOR_PROFILE", undefined);
        await acquireSharedDockerRunner({
            dockerSocket: false,
            imageId: "fixture",
            repositoryRoot: "/default-profile",
        });
        const run = docker.execFile.mock.calls.find(([, args]) => args[0] === "run");
        expect(run?.[1]).toContain("apparmor=unconfined");
    });

    it("selects the named CI profile and never reuses a runner with another profile", async () => {
        const options = {
            dockerSocket: false,
            imageId: "fixture",
            repositoryRoot: "/selected-profile",
        };
        vi.stubEnv("HAPPY_TERMINAL_GYM_DOCKER_APPARMOR_PROFILE", undefined);
        const defaultRunner = await acquireSharedDockerRunner(options);
        vi.stubEnv("HAPPY_TERMINAL_GYM_DOCKER_APPARMOR_PROFILE", "happy-compute-container-tests");
        const selected = await acquireSharedDockerRunner(options);
        expect(selected.containerName).not.toBe(defaultRunner.containerName);
        expect(await acquireSharedDockerRunner(options)).toBe(selected);
        const runs = docker.execFile.mock.calls.filter(([, args]) => args[0] === "run");
        expect(runs).toHaveLength(2);
        expect(runs[0]?.[1]).toContain("apparmor=unconfined");
        expect(runs[1]?.[1]).toContain("apparmor=happy-compute-container-tests");
    });
});
