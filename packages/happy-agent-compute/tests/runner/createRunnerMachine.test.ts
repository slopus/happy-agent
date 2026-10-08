import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { createRunnerMachine } from "../../sources/runner/index.js";

const ctx = createRootContext().named("runner-machine-test");
const folders: string[] = [];

afterEach(async () => {
    for (const folder of folders.splice(0)) await rm(folder, { force: true, recursive: true });
});

describe.runIf(process.platform !== "win32")("the machines a runner builds", () => {
    it("is the host compute for an ordinary request", async () => {
        const cwd = await folder();
        const machine = createRunnerMachine(ctx, { cwd, policy: {} });

        expect(machine.id).toBe("host");
        expect(machine.processes).toBeDefined();
        await machine.dispose(ctx);
    });

    it("runs agent work in the container but keeps the product's programs on the runner", async () => {
        const cwd = await folder();
        const machine = createRunnerMachine(ctx, {
            cwd,
            policy: { protectedProjectFiles: ["happy.toml"] },
            docker: { image: "ghcr.io/acme/dev:latest" },
        });

        expect(machine.id).toBe("docker");
        expect(machine.cwd).toBe(cwd);
        const started = await machine.processes!.start(ctx, {
            command: "sh",
            args: ["-c", "echo runner > marker"],
            cwd,
        });
        await expect(started.exited).resolves.toEqual({ exitCode: 0, signal: null });
        await expect(readFile(join(cwd, "marker"), "utf8")).resolves.toBe("runner\n");
        await machine.dispose(ctx);
    });
});

async function folder(): Promise<string> {
    const created = await mkdtemp(join(tmpdir(), "runner-machine-"));
    folders.push(created);
    return created;
}
