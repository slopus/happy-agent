// The standalone CLI speaks to a mock daemon, while its shell and filesystem remain real.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
const require = createRequire(resolve("packages/happy-agent/package.json"));
const { WebSocketServer } = require("ws");
const root = await mkdtemp(join(tmpdir(), "native-runner-cli-"));
const token = "0123456789012345678901234567890123456789012";
const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/prefix/v0/runners/connect" });
await once(wss, "listening");
const home = join(root, "home");
const workspace = join(home, "workspace");
await mkdir(workspace, { recursive: true });
await mkdir(join(home, "happy/config"), { recursive: true });
await writeFile(join(home, "happy/config/happy.toml"), "malformed [daemon configuration");
await writeFile(join(home, "happy/config/mcp.toml"), "malformed [daemon configuration");
let child,
    socket,
    log = "";
const timeout = setTimeout(() => {
    console.error("CLI probe timed out.");
    child?.kill("SIGKILL");
    process.exitCode = 1;
    wss.close();
}, 30000);
const pending = new Map();
let next = 1;
function encode(header, body = Buffer.alloc(0)) {
    const bytes = Buffer.from(JSON.stringify(header));
    const size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    return Buffer.concat([size, bytes, body]);
}
const ready = new Promise((ok, fail) =>
    wss.once("connection", (ws, request) => {
        try {
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            socket = ws;
        } catch (error) {
            fail(error);
            return;
        }
        ws.on("message", (bytes, isBinary) => {
            try {
                assert(isBinary);
                const length = bytes.readUInt32BE();
                const header = JSON.parse(bytes.subarray(4, 4 + length));
                const body = bytes.subarray(4 + length);
                if (header.type === "hello") {
                    assert.equal(header.runner.home, home);
                    ws.send(
                        encode({
                            type: "welcome",
                            protocol: 1,
                            instanceId: "cli-probe-daemon",
                            leaseGraceMs: 0,
                        }),
                    );
                } else if (header.type === "ready") {
                    ok(header);
                } else if (header.type === "response") {
                    const callback = pending.get(header.id);
                    pending.delete(header.id);
                    callback?.({ header, body });
                } else if (header.type === "ping") {
                    ws.send(encode({ type: "pong", nonce: header.nonce }));
                } else if (header.type === "event" && header.seq) {
                    ws.send(encode({ type: "ack", seq: header.seq }));
                }
            } catch (error) {
                fail(error);
            }
        });
    }),
);
function rpc(method, params, body) {
    const id = next++;
    const promise = new Promise((ok) => pending.set(id, ok));
    socket.send(encode({ type: "request", id, method, params }, body));
    return promise;
}
const permissions = { mode: "full_access", network: { egress: true, localBinding: true } };
try {
    child = spawn(
        resolve("target/debug/happy-agent"),
        ["runner", "--endpoint", `http://127.0.0.1:${wss.address().port}/prefix`],
        {
            env: {
                ...process.env,
                HOME: home,
                HAPPY_HOME_DIR: join(home, ".happy"),
                HAPPY_RUNNER_TOKEN: token,
                HAPPY_RUNNER_ENDPOINT: "https://invalid.example",
            },
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    child.stdout.on("data", (bytes) => (log += bytes));
    child.stderr.on("data", (bytes) => (log += bytes));
    child.once("exit", (code) => {
        if (!socket) {
            console.error(`Runner exited before handshake (${code}): ${log}`);
        }
    });
    await ready;
    assert(!log.includes(token));
    for (const path of [
        ".happy/agent/agent.sqlite",
        ".happy/agent/token",
        ".happy-runner/agent/agent.sqlite",
        ".happy-runner/agent/token",
    ]) {
        await assert.rejects(access(join(home, path)));
    }
    let answer = await rpc("compute.create", { computeId: "machine", cwd: workspace });
    assert.equal(answer.header.result.kind, "host");
    answer = await rpc("shell.run", {
        computeId: "machine",
        options: {
            command:
                'printf "%s|%s" "${HAPPY_RUNNER_TOKEN-unset}" "${HAPPY_RUNNER_ENDPOINT-unset}"',
            permissions,
        },
    });
    assert(!answer.header.error, JSON.stringify(answer.header));
    assert.equal(answer.header.result.result.stdout, "unset|unset");
    assert.equal(answer.header.result.result.exitCode, 0);
    answer = await rpc("shell.startSession", {
        computeId: "machine",
        options: { command: 'read value; printf "%s" "$value"', permissions },
    });
    assert(!answer.header.error, JSON.stringify(answer.header));
    const sessionId = answer.header.result.sessionId;
    answer = await rpc("shell.detachSession", { computeId: "machine", sessionId });
    assert(!answer.header.error, JSON.stringify(answer.header));
    answer = await rpc(
        "shell.writeSession",
        { computeId: "machine", sessionId, permissions, encoding: "text" },
        Buffer.from("owned-detached\n"),
    );
    assert(!answer.header.error, JSON.stringify(answer.header));
    assert.equal(answer.header.result.written, true);
    answer = await rpc("shell.readSession", { computeId: "machine", sessionId, waitMs: 5000 });
    assert(!answer.header.error, JSON.stringify(answer.header));
    assert.equal(answer.header.result.snapshot.stdout, "owned-detached");
    answer = await rpc("fs.stat", { computeId: "machine", path: "missing", permissions });
    assert.equal(answer.header.error.code, "ENOENT");
    answer = await rpc("compute.dispose", { computeId: "machine" });
    assert(!answer.header.error);
    child.kill("SIGTERM");
    const [code, signal] = await once(child, "exit");
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert(!log.includes(token));
    console.log(
        "Native production runner CLI: credential scrub, prefixed endpoint, shared shell RPC and detached stdin lifetime, Source ENOENT, no daemon SQLite/token, and signal shutdown passed.",
    );
} finally {
    clearTimeout(timeout);
    child?.kill("SIGKILL");
    socket?.terminate();
    await new Promise((ok) => wss.close(ok));
    await rm(root, { recursive: true, force: true });
}
