import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Compute } from "../../sources/Compute.js";
import { allowEverything } from "../../sources/ComputePermissions.js";
import type { ComputeServiceStartOptions } from "../../sources/ComputeServices.js";
import { createHostCompute } from "../../sources/host/createHostCompute.js";

const live = process.env.HAPPY_AGENT_COMPUTE_SERVICE_LIVE_TEST === "1";
const ctx = createRootContext().named("service-runtime-live-tests");
const fixtures: { root: string; compute: Compute; start: ComputeServiceStartOptions }[] = [];
const sockets = new Set<Socket>();
const controllers = new Map<ChildProcess, Promise<void>>();

describe.runIf(live)("published native service runtime", () => {
    beforeAll(() => {
        if (process.platform !== "linux" || !process.env.HAPPY_SERVICE_TEST_CGROUP_PARENT) {
            throw new Error(
                "Service integration tests require Linux and an explicitly delegated test cgroup.",
            );
        }
    });

    afterEach(async () => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        for (const [child, exited] of controllers) {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            await exited;
        }
        controllers.clear();
        for (const { root, compute, start } of fixtures) {
            await compute.dispose(ctx);
            await compute.services!.reconcile(ctx, start.execution);
            // Exactly the disposable fixture, and only after the production cleanup proof.
            await rm(root, { recursive: true });
        }
        fixtures.length = 0;
    }, 30000);

    it.each([false, true])(
        "supports independent readers and interactive input (tty=%s)",
        async (tty) => {
            const { service, start } = await launch(undefined, tty);
            expect(await service.admitted).toBe(true);
            await until(() => service.read({ stdout: 0, stderr: 0 }).stdout.includes("ready"));
            const first = service.read({ stdout: 0, stderr: 0 });
            expect(service.read({ stdout: 0, stderr: 0 })).toEqual(first);
            expect(await service.write(ctx, allowEverything(), "hello\n")).toBe(true);
            await until(() => service.read(first.position).stdout.includes("reply:hello"));
            expect(service.read({ stdout: 0, stderr: 0 }).stdout).toContain("ready");
            expect(await service.stop(ctx)).toMatchObject({ killed: true, startupFailed: false });
            expect(await service.write(ctx, allowEverything(), "late\n")).toBe(false);
            await expect(
                readFile(join(start.execution.directory, "policy.json")),
            ).rejects.toMatchObject({ code: "ENOENT" });
        },
        20000,
    );

    it("keeps external input edits live while scratch writes remain private", async () => {
        const { cwd, service } = await launch(
            "printf ready; read value; cat src/value; printf private > out/result; exec sleep 60",
        );
        await until(() => service.read({ stdout: 0, stderr: 0 }).stdout.includes("ready"));
        await writeFile(join(cwd, "src", "replacement"), "new-value");
        await rename(join(cwd, "src", "replacement"), join(cwd, "src", "value"));
        await service.write(ctx, allowEverything(), "continue\n");
        await until(() => service.read({ stdout: 0, stderr: 0 }).stdout.includes("new-value"));
        await service.stop(ctx);
        await expect(readFile(join(cwd, "out", "result"))).rejects.toMatchObject({
            code: "ENOENT",
        });
        expect(await readFile(join(cwd, "src", "value"), "utf8")).toBe("new-value");
    }, 20000);

    it("forwards only application bytes through the private authenticated bridge", async () => {
        const fixture = await prepare();
        await writeFile(
            join(fixture.cwd, "src", "server.py"),
            [
                "import socket",
                "s = socket.socket()",
                "s.bind(('127.0.0.1', 4187))",
                "s.listen()",
                "print('listening', flush=True)",
                "c, _ = s.accept()",
                "data = b''",
                "while b'\\r\\n\\r\\n' not in data and len(data) < 4096:",
                "    part = c.recv(4096 - len(data))",
                "    if not part: break",
                "    data += part",
                "body = b'ok' if data.startswith(b'GET / HTTP/1.1\\r\\n') else b'credential-leak'",
                "c.sendall(b'HTTP/1.1 200 OK\\r\\nConnection: close\\r\\nContent-Length: ' + str(len(body)).encode() + b'\\r\\n\\r\\n' + body)",
                "c.close()",
                "s.close()",
            ].join("\n"),
        );
        fixture.start.command = "python3 -u src/server.py; exec sleep 60";
        const service = await fixture.compute.services!.start(ctx, fixture.start);
        await until(() => service.read({ stdout: 0, stderr: 0 }).stdout.includes("listening"));
        const socket = await service.connect(ctx);
        sockets.add(socket);
        const response = new Promise<string>((resolve, reject) => {
            let text = "";
            socket.on("data", (chunk: Buffer) => {
                text += chunk.toString();
                if (text.length > 4096) socket.destroy(new Error("Oversized fixture response"));
            });
            socket.once("end", () => resolve(text));
            socket.once("error", reject);
        });
        socket.write("GET / HTTP/1.1\r\nHost: service.test\r\n\r\n");
        socket.resume();
        expect(await response).toMatch(/\r\n\r\nok$/u);
        await service.stop(ctx);
    }, 20000);

    it("kills services on controller death and reconciles without rerunning them", async () => {
        const fixture = await prepare();
        const child = spawn(
            process.execPath,
            [
                fileURLToPath(new URL("../fixtures/serviceController.mjs", import.meta.url)),
                fixture.cwd,
                fixture.privateDirectory,
                fixture.start.execution.id,
                process.env.HAPPY_SERVICE_TEST_CGROUP_PARENT!,
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "";
        const collect = (chunk: Buffer) => {
            output = (output + chunk.toString()).slice(-16384);
        };
        child.stdout!.on("data", collect);
        child.stderr!.on("data", collect);
        const exited = new Promise<void>((resolve, reject) => {
            child.once("close", () => resolve());
            child.once("error", reject);
        });
        controllers.set(child, exited);
        await until(
            () => output.includes("controller-ready"),
            () => output,
        );
        child.kill("SIGKILL");
        await exited;
        await fixture.compute.services!.reconcile(ctx, fixture.start.execution);
        await expect(
            readFile(join(fixture.start.execution.directory, "policy.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(join(fixture.cwd, "src", "value"), "utf8")).toBe("original");
    }, 30000);

    it("distinguishes an application exit 125 from a sandbox startup failure", async () => {
        const { service } = await launch("exit 125");
        expect(await service.completion).toMatchObject({ exitCode: 125, startupFailed: false });
    }, 20000);
});

async function prepare() {
    const scratch = fileURLToPath(new URL("../../../../.context/", import.meta.url));
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(join(scratch, "sv-"));
    const cwd = join(root, "w");
    const privateDirectory = join(root, "p");
    await mkdir(cwd);
    await mkdir(privateDirectory, { mode: 0o700 });
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "value"), "original");
    const compute = createHostCompute({
        ctx,
        cwd,
        hostPolicy: { privateDirectories: [privateDirectory] },
        serviceCgroupParent: process.env.HAPPY_SERVICE_TEST_CGROUP_PARENT!,
    });
    const id = randomBytes(12).toString("hex");
    const start: ComputeServiceStartOptions = {
        execution: { id, directory: join(privateDirectory, id) },
        command: "printf ready; read value; printf 'reply:%s' \"$value\"; exec sleep 60",
        cwd: ".",
        port: 4187,
        tty: false,
        permissions: allowEverything(),
        sandbox: {
            inputs: ["src"],
            scratch: ["out"],
            outbound: [],
            limits: { memoryMiB: 128, processes: 32 },
        },
    };
    fixtures.push({ root, compute, start });
    return { root, cwd, privateDirectory, compute, start };
}

async function launch(command?: string, tty = false) {
    const fixture = await prepare();
    if (command !== undefined) fixture.start.command = command;
    fixture.start.tty = tty;
    const service = await fixture.compute.services!.start(ctx, fixture.start);
    return { ...fixture, service };
}

async function until(predicate: () => boolean, detail?: () => string) {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
        if (Date.now() >= deadline)
            throw new Error(`Service fixture did not become ready. ${detail?.() ?? ""}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
}
