import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect, createServer, type AddressInfo } from "node:net";
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

describe("the machines a runner builds", () => {
    it("is the host compute for an ordinary request", async () => {
        const cwd = await folder();
        const machine = createRunnerMachine(ctx, { cwd, policy: {} });

        expect(machine.id).toBe("host");
        expect(machine.processes).toBeDefined();
        await machine.dispose(ctx);
    });

    // Containers on a runner are Linux containers driven from a POSIX shell.
    it.runIf(process.platform !== "win32")(
        "runs agent work in the container but keeps the product's programs on the runner",
        async () => {
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
        },
    );
});

describe.runIf(process.platform !== "win32")("connections from a container machine", () => {
    it("never connects from the runner's own network, even when the container is unreachable", async () => {
        let reachedRunner = false;
        const server = createServer((socket) => {
            reachedRunner = true;
            socket.destroy();
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;
        const machine = createRunnerMachine(ctx, {
            cwd: await folder(),
            policy: {},
            docker: { image: "happy-agent-compute-test.invalid/missing:latest" },
        });

        // The image does not exist, so the container never starts and the connection must fail
        // rather than be made from the runner, where this port is a different program.
        await expect(machine.network!.connect(ctx, { host: "127.0.0.1", port })).rejects.toThrow();
        expect(reachedRunner).toBe(false);
        await machine.dispose(ctx);
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }, 30_000);

    it("keeps loopback listeners on the runner, where Git runs", async () => {
        const machine = createRunnerMachine(ctx, {
            cwd: await folder(),
            policy: {},
            docker: { image: "happy-agent-compute-test.invalid/missing:latest" },
        });
        const listener = await machine.network!.listen!(ctx);
        const accepted = new Promise<string>((resolve) =>
            listener.onConnection((socket) => {
                socket.once("data", (chunk: Buffer) => resolve(chunk.toString()));
                // Accepted connections arrive paused until their reader is ready.
                socket.resume();
            }),
        );

        connect({ host: "127.0.0.1", port: listener.port }).end("credential request");

        await expect(accepted).resolves.toBe("credential request");
        listener.close();
        await machine.dispose(ctx);
    });
});

async function folder(): Promise<string> {
    const created = await mkdtemp(join(tmpdir(), "runner-machine-"));
    folders.push(created);
    return created;
}
