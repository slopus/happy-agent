// Run the production Windows runner against a fixture daemon; all processes are real.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

assert.equal(process.platform, "win32", "This gate needs native Windows.");
assert(process.argv[2], "Select the built Windows executable.");
const binary = resolve(process.argv[2]);
const require = createRequire(resolve("packages/happy-agent-gym/package.json"));
const { WebSocketServer } = require("ws");
const root = await mkdtemp(join(tmpdir(), "happy-windows-runner-"));
const workspace = join(root, "workspace");
await mkdir(workspace);
const token = "0123456789012345678901234567890123456789012";
const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/prefix/v0/runners/connect" });
await once(wss, "listening");
let runner,
    socket,
    log = "",
    next = 1;
const pending = new Map();
const streams = new Map();
let failTransport;
const transportFailure = new Promise((_, fail) => {
    failTransport = fail;
});
const permissions = { mode: "full_access", network: { egress: true, localBinding: true } };
function encode(header, body = Buffer.alloc(0)) {
    const bytes = Buffer.from(JSON.stringify(header));
    const size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    return Buffer.concat([size, bytes, body]);
}
function send(header, body) {
    socket.send(encode(header, body));
}
function rpc(method, params, body) {
    const id = next++;
    const answer = new Promise((ok) => pending.set(id, ok));
    send({ type: "request", id, method, params }, body);
    return Promise.race([answer, transportFailure]).then(({ header, body }) => {
        assert(!header.error, JSON.stringify(header));
        return { result: header.result, body };
    });
}
function stream(id) {
    let changed;
    const value = {
        out: [],
        err: [],
        exit: undefined,
        wake() {
            changed?.();
        },
        async until(predicate) {
            while (!predicate(value))
                await Promise.race([
                    new Promise((ok) => {
                        changed = ok;
                    }),
                    transportFailure,
                ]);
            return value;
        },
    };
    streams.set(id, value);
    return value;
}
const ready = new Promise((ok, fail) =>
    wss.once("connection", (ws, request) => {
        try {
            assert.equal(request.headers.authorization, `Bearer ${token}`);
        } catch (error) {
            fail(error);
            return;
        }
        socket = ws;
        ws.on("message", (bytes, isBinary) => {
            try {
                assert(isBinary);
                const length = bytes.readUInt32BE();
                const header = JSON.parse(bytes.subarray(4, 4 + length));
                const body = bytes.subarray(4 + length);
                if (header.type === "hello") {
                    assert.equal(header.runner.platform, "win32");
                    send({
                        type: "welcome",
                        protocol: 1,
                        instanceId: "windows-cli-proof",
                        leaseGraceMs: 0,
                    });
                } else if (header.type === "ready") ok(header);
                else if (header.type === "response") {
                    const callback = pending.get(header.id);
                    pending.delete(header.id);
                    callback?.({ header, body });
                } else if (header.type === "ping") send({ type: "pong", nonce: header.nonce });
                else if (header.type === "event" && header.seq)
                    send({ type: "ack", seq: header.seq });
                else if (header.type === "data") {
                    const value = streams.get(header.stream);
                    assert(value, `Unexpected stream ${header.stream}`);
                    const chunks = value[header.channel];
                    assert.equal(
                        header.offset,
                        chunks.reduce((count, piece) => count + piece.length, 0),
                    );
                    chunks.push(Buffer.from(body));
                    send({
                        type: "flow",
                        stream: header.stream,
                        channel: header.channel,
                        consumed: header.offset + body.length,
                    });
                    value.wake();
                } else if (header.type === "exit") {
                    const value = streams.get(header.stream);
                    value.exit = header;
                    value.wake();
                }
            } catch (error) {
                fail(error);
                failTransport(error);
            }
        });
    }),
);
const output = (value) => Buffer.concat(value.out).toString("utf8");
const errorOutput = (value) => Buffer.concat(value.err).toString("utf8");
const timeout = setTimeout(() => {
    console.error(`Windows production runner gate timed out.\n${log}`);
    runner?.kill("SIGKILL");
    socket?.terminate();
    process.exit(1);
}, 90_000);
try {
    runner = spawn(
        binary,
        ["runner", "--endpoint", `http://127.0.0.1:${wss.address().port}/prefix`],
        {
            env: {
                ...process.env,
                USERPROFILE: root,
                HAPPY_RUNNER_TOKEN: token,
                HAPPY_RUNNER_ENDPOINT: "https://invalid.example",
                COMSPEC: process.env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe",
            },
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        },
    );
    runner.stdout.on("data", (bytes) => {
        log += bytes;
    });
    runner.stderr.on("data", (bytes) => {
        log += bytes;
    });
    const exited = once(runner, "exit");
    await Promise.race([
        ready,
        transportFailure,
        exited.then(([code]) => {
            throw new Error(`Runner exited before ready (${code}): ${log}`);
        }),
    ]);
    for (const computeId of ["machine", "isolated"]) {
        const answer = await rpc("compute.create", { computeId, cwd: workspace });
        assert.equal(answer.result.kind, "host");
    }
    const shell = await rpc("shell.run", {
        computeId: "machine",
        options: { command: 'echo "native ping"&echo NATIVE_DONE', permissions },
    });
    assert.equal(shell.result.result.exitCode, 0);
    assert.match(shell.result.result.stdout, /"native ping"\r?\nNATIVE_DONE/);
    const echo = stream(1);
    await rpc("process.start", {
        computeId: "machine",
        stream: 1,
        command: process.execPath,
        args: [
            "-e",
            'if(process.env.HAPPY_RUNNER_TOKEN||process.env.HAPPY_RUNNER_ENDPOINT)process.exit(99);process.stdout.write("INPUT_READY\\n");process.stdin.once("data",bytes=>{process.stdout.write(bytes);process.stderr.write("separate-error");process.exit(37)})',
        ],
        environment: { HAPPY_WINDOWS_SELECTED: "selected" },
    });
    await echo.until((value) => output(value).includes("INPUT_READY"));
    const bytes = Buffer.from("native detached 🎉\n");
    send({ type: "data", stream: 1, channel: "in", offset: 0 }, bytes);
    await echo.until((value) => value.exit);
    assert.equal(echo.exit.exitCode, 37);
    assert(output(echo).endsWith(bytes.toString("utf8")));
    assert.equal(errorOutput(echo), "separate-error");
    const ended = stream(2);
    await rpc("process.start", {
        computeId: "machine",
        stream: 2,
        command: process.execPath,
        args: [
            "-e",
            'process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write("INPUT_ENDED");process.exit(7)})',
        ],
    });
    send({ type: "eof", stream: 2, channel: "in", offset: 0 });
    await ended.until((value) => value.exit);
    assert.equal(ended.exit.exitCode, 7);
    assert.equal(output(ended), "INPUT_ENDED");
    const terminal = stream(5);
    const powershell = join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
    );
    await rpc("process.start", {
        computeId: "machine",
        stream: 5,
        command: powershell,
        args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            '[Console]::WriteLine("TTY_READY:"+[Console]::WindowWidth+"x"+[Console]::WindowHeight); $line=[Console]::ReadLine(); [Console]::WriteLine("TTY_RESULT:"+$line+":"+[Console]::WindowWidth+"x"+[Console]::WindowHeight); [Console]::Error.WriteLine("TTY_ERROR"); exit 7',
        ],
        terminal: { cols: 84, rows: 21, name: "xterm-256color" },
    });
    await terminal.until((value) => output(value).includes("TTY_READY:84x21"));
    await rpc("process.resize", { stream: 5, cols: 112, rows: 37 });
    send({ type: "data", stream: 5, channel: "in", offset: 0 }, Buffer.from("terminal ping\r\n"));
    await terminal.until((value) => value.exit);
    assert.equal(terminal.exit.exitCode, 7);
    assert(output(terminal).includes("TTY_RESULT:terminal ping:112x37"));
    assert(output(terminal).includes("TTY_ERROR"));
    assert.equal(errorOutput(terminal), "");
    for (const mode of ["read_only", "workspace_write", "auto"]) {
        const id = next++;
        const answer = new Promise((ok) => pending.set(id, ok));
        send({
            type: "request",
            id,
            method: "shell.run",
            params: {
                computeId: "machine",
                options: {
                    command: "echo changed>AGENTS.md",
                    permissions: { mode, network: { egress: false, localBinding: false } },
                },
            },
        });
        const { header } = await answer;
        assert(header.error, `${mode} must fail before launch`);
        assert.match(
            header.error.message,
            mode === "read_only" ? /dedicated-account/ : /atomic filename boundary/,
        );
        await assert.rejects(access(join(workspace, "AGENTS.md")));
    }
    const survivor = stream(3);
    await rpc("process.start", {
        computeId: "isolated",
        stream: 3,
        command: process.execPath,
        args: [
            "-e",
            'process.stdout.write("SURVIVOR_READY\\n");process.stdin.once("data",()=>{process.stdout.write("SURVIVOR_DONE");process.exit(0)})',
        ],
    });
    await survivor.until((value) => output(value).includes("SURVIVOR_READY"));
    const tree = stream(4);
    await rpc("process.start", {
        computeId: "machine",
        stream: 4,
        command: process.execPath,
        args: [
            "-e",
            'const child=require("child_process").spawn(process.execPath,["-e","process.stdin.resume()"],{stdio:"inherit"});process.stdout.write("TREE_READY:"+child.pid+"\\n");process.stdin.resume()',
        ],
    });
    await tree.until((value) => output(value).includes("TREE_READY:"));
    const descendant = Number(/TREE_READY:(\d+)/.exec(output(tree))[1]);
    process.kill(descendant, 0);
    await rpc("process.signal", { stream: 4, signal: "SIGKILL" });
    await tree.until((value) => value.exit);
    assert.notEqual(tree.exit.exitCode, 0);
    assert.throws(() => process.kill(descendant, 0));
    await rpc("compute.dispose", { computeId: "machine" });
    send({ type: "data", stream: 3, channel: "in", offset: 0 }, Buffer.from("continue\n"));
    await survivor.until((value) => value.exit);
    assert.equal(survivor.exit.exitCode, 0);
    assert(output(survivor).endsWith("SURVIVOR_DONE"));
    await rpc("compute.dispose", { computeId: "isolated" });
    assert(!log.includes(token));
    for (const path of [".happy-runner/agent/agent.sqlite", ".happy-runner/agent/token"])
        await assert.rejects(access(join(root, path)));
    console.log(
        "Native Windows production runner: shell quotes, credential scrub, Unicode input, separate output, explicit EOF, real descendant cleanup, compute isolation, and restricted admission passed.",
    );
} finally {
    clearTimeout(timeout);
    runner?.kill("SIGKILL");
    socket?.terminate();
    await new Promise((ok) => wss.close(ok));
    if (runner && runner.exitCode === null && runner.signalCode === null)
        await once(runner, "exit");
    await rm(root, { recursive: true, force: true });
}
