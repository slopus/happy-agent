import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext, withLogger, type Logger } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { startTailcatExposure } from "../../sources/tailcat/impl/startTailcatExposure.js";
import { tailcatPipeCommand } from "../../sources/tailcat/impl/tailcatPipeCommand.js";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Tailcat exposure", () => {
    it("generates one stable fixed-region key and keeps only the key after closing", async () => {
        const root = await temporaryRoot();
        const fake = await fakeTailcat(root);
        const paths = tailcatPaths(root);
        const target = { host: "127.0.0.1", port: 9 } as const;
        const port = 24_790;

        const first = await startTailcatExposure(
            createRootContext().named("tailcat-first"),
            target,
            paths,
            port,
            { executable: fake, restartDelayMs: 10, startupTimeoutMs: 5_000, stopGraceMs: 50 },
        );

        expect(first.address).toBe("tcStableTailcatAddress123");
        expect(first.port).toBe(port);
        expect((await readFile(paths.portPath, "utf8")).trim()).toBe(String(first.port));
        expect((await stat(paths.keyPath)).mode & 0o777).toBe(0o600);
        expect((await stat(paths.addressPath)).mode & 0o777).toBe(0o600);
        await first.close();

        await expect(readFile(paths.addressPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(paths.portPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(paths.keyPath, "utf8")).resolves.toBe("stable-private-key\n");

        const second = await startTailcatExposure(
            createRootContext().named("tailcat-second"),
            target,
            paths,
            port,
            { executable: fake, restartDelayMs: 10, startupTimeoutMs: 5_000, stopGraceMs: 50 },
        );
        expect(second.address).toBe(first.address);
        expect(second.port).toBe(first.port);
        await second.close();

        const invocations = (await readFile(join(root, "tailcat-invocations"), "utf8"))
            .trim()
            .split("\n");
        expect(invocations.filter((line) => line.startsWith("genkey "))).toHaveLength(1);
        expect(invocations.filter((line) => line.split(/\s+/u).includes("serve"))).toHaveLength(2);
        expect(invocations[0]).toContain("--fixed-region");
    });

    it("keeps reopening after Tailcat exits and one reopen fails", async () => {
        const root = await temporaryRoot();
        const fake = await fakeTailcat(root, true);
        const exposure = await startTailcatExposure(
            createRootContext().named("tailcat-restart"),
            { host: "127.0.0.1", port: 9 },
            tailcatPaths(root),
            24_782,
            { executable: fake, restartDelayMs: 10, startupTimeoutMs: 5_000, stopGraceMs: 50 },
        );

        await waitFor(async () => Number(await readFile(join(root, "tailcat-runs"), "utf8")) >= 3);
        expect(exposure.address).toBe("tcStableTailcatAddress123");

        await exposure.close();
    });
});

describe("Tailcat exposure logging", () => {
    it("never logs the secret address", async () => {
        const root = await temporaryRoot();
        const fake = await fakeTailcat(root);
        const lines: string[] = [];
        const ctx = withLogger(
            createRootContext().named("tailcat-logging"),
            recordingLogger(lines),
        );
        const exposure = await startTailcatExposure(
            ctx,
            { host: "127.0.0.1", port: 9 },
            tailcatPaths(root),
            24_789,
            { executable: fake, restartDelayMs: 10, startupTimeoutMs: 5_000, stopGraceMs: 50 },
        );
        expect(exposure.address).toBe("tcStableTailcatAddress123");
        await exposure.close();
        expect(lines.find((line) => line.startsWith("tailcat:open "))).toMatch(
            /^tailcat:open port=24789 pid=\d+$/u,
        );
        expect(lines.join("\n")).not.toContain("tcStableTailcatAddress123");
    });
});

describe("Tailcat exposure ports", () => {
    it("opens on a port another program holds, because it binds no local port", async () => {
        const root = await temporaryRoot();
        const fake = await fakeTailcat(root);
        const occupant = createNetServer();
        await new Promise<void>((resolve, reject) => {
            occupant.once("error", reject);
            occupant.listen(0, "127.0.0.1", resolve);
        });
        const address = occupant.address();
        if (address === null || typeof address === "string") throw new Error("No port is held.");
        try {
            const exposure = await startTailcatExposure(
                createRootContext().named("tailcat-held-port"),
                { socketPath: join(root, "api.sock") },
                tailcatPaths(root),
                address.port,
                { executable: fake, restartDelayMs: 10, startupTimeoutMs: 5_000, stopGraceMs: 50 },
            );
            expect(exposure.port).toBe(address.port);
            await exposure.close();
        } finally {
            await new Promise<void>((resolve) => occupant.close(() => resolve()));
        }
        const invocations = await readFile(join(root, "tailcat-invocations"), "utf8");
        expect(invocations).toContain(
            `--key=${tailcatPaths(root).keyPath} serve exec -- ${process.execPath} -e `,
        );
        expect(invocations).not.toContain(`serve ${String(address.port)}`);
    });
});

describe("Tailcat connection pipe", () => {
    it("carries HTTP, streamed as it arrives, to a Unix-socket daemon and exits after", async () => {
        const root = await temporaryRoot();
        const socketPath = join(root, "server.sock");
        let finishStream: (() => void) | undefined;
        const server = createServer((request, response) => {
            if (request.url === "/stream") {
                response.writeHead(200, { "content-type": "text/event-stream" });
                response.write("data: first\n\n");
                finishStream = () => response.end("data: last\n\n");
                return;
            }
            response.end("through socket");
        });
        await listenOn(server, socketPath);
        try {
            const plain = pipeConnection(tailcatPipeCommand({ socketPath }));
            plain.write("GET /test HTTP/1.1\r\nhost: tailcat\r\nconnection: close\r\n\r\n");
            await expect(plain.exited).resolves.toBe(0);
            expect(plain.output()).toMatch(/^HTTP\/1\.1 200 OK\r\n[\s\S]*\r\n\r\nthrough socket$/u);

            // The first event reaches the peer while the response is still open.
            const stream = pipeConnection(tailcatPipeCommand({ socketPath }));
            stream.write("GET /stream HTTP/1.1\r\nhost: tailcat\r\n\r\n");
            await waitFor(async () => stream.output().includes("data: first"));
            expect(stream.output()).not.toContain("data: last");
            finishStream?.();
            await waitFor(async () => stream.output().includes("data: last"));
            stream.end();
            await expect(stream.exited).resolves.toBe(0);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("reaches a TCP daemon listening on every address, and exits when the peer leaves", async () => {
        const server = createServer((_request, response) => response.end("through tcp"));
        await listenOn(server, { host: "0.0.0.0", port: 0 });
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("No TCP port.");
        try {
            const pipe = tailcatPipeCommand({ host: "0.0.0.0", port: address.port });
            const answered = pipeConnection(pipe);
            answered.write("GET / HTTP/1.1\r\nhost: tailcat\r\n\r\n");
            await waitFor(async () => answered.output().endsWith("through tcp"));
            // The peer closes a kept-alive connection; the daemon never would.
            answered.end();
            await expect(answered.exited).resolves.toBe(0);
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("exits at once when nothing listens at the target", async () => {
        const root = await temporaryRoot();
        const pipe = pipeConnection(tailcatPipeCommand({ socketPath: join(root, "none") }));
        await expect(pipe.exited).resolves.toBe(0);
        expect(pipe.output()).toBe("");
    });
});

interface PipeConnection {
    readonly exited: Promise<number | null>;
    output(): string;
    write(text: string): void;
    end(): void;
}

/** Run the pipe as Tailcat's exec service does, with one connection as its stdin and stdout. */
function pipeConnection(pipe: ReturnType<typeof tailcatPipeCommand>): PipeConnection {
    const [command, ...args] = pipe.command;
    const child = spawn(command!, args, {
        env: { ...process.env, ...pipe.environment },
        stdio: ["pipe", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
        output += chunk;
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    // A pipe that already exited takes no input.
    child.stdin.on("error", () => undefined);
    return {
        exited,
        output: () => output,
        write: (text: string) => child.stdin.write(text),
        end: () => child.stdin.end(),
    };
}

async function listenOn(
    server: ReturnType<typeof createServer>,
    at: string | { host: string; port: number },
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        if (typeof at === "string") server.listen(at, resolve);
        else server.listen(at.port, at.host, resolve);
    });
}

async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "happy-tailcat-"));
    roots.push(root);
    return root;
}

function tailcatPaths(root: string) {
    const home = join(root, "tailcat");
    return {
        addressPath: join(home, "address"),
        home,
        keyPath: join(home, "default.private.json"),
        portPath: join(home, "port"),
    };
}

async function fakeTailcat(root: string, exerciseRestartFailure = false): Promise<string> {
    const path = join(root, "fake-tailcat");
    await writeFile(
        path,
        `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
appendFileSync(join(root, "tailcat-invocations"), args.join(" ") + "\\n");
if (args[0] === "genkey") {
    const key = args.find((argument) => argument.startsWith("--key="))?.slice(6);
    if (key === undefined) process.exit(2);
    writeFileSync(key, "stable-private-key\\n", { mode: 0o600 });
    process.exit(0);
}
const runsPath = join(root, "tailcat-runs");
const runs = (existsSync(runsPath) ? Number(readFileSync(runsPath, "utf8")) : 0) + 1;
writeFileSync(runsPath, String(runs) + "\\n");
if (${String(exerciseRestartFailure)} && runs === 2) process.exit(8);
writeFileSync(process.env.TAILCAT_ADDR_FILE, "tcStableTailcatAddress123\\n", { mode: 0o600 });
if (${String(exerciseRestartFailure)} && runs === 1) process.exit(7);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
setInterval(() => undefined, 1_000);
`,
    );
    await chmod(path, 0o755);
    return path;
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        try {
            if (await condition()) return;
        } catch {
            // The observed file may not exist yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Tailcat did not reach the expected state in time.");
}

function recordingLogger(lines: string[]): Logger {
    const write = (_context: unknown, ...args: readonly unknown[]) => {
        lines.push(args.map(String).join(" "));
    };
    return { debug: write, error: write, fatal: write, info: write, trace: write, warn: write };
}
