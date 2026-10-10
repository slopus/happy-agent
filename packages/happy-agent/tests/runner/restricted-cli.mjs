import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, access, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { promisify } from "node:util";
const require = createRequire(resolve("packages/happy-agent/package.json"));
const { WebSocketServer } = require("ws");
const root = await mkdtemp(join(tmpdir(), "native-runner-restricted-"));
const token = "0123456789012345678901234567890123456789012";
const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/v0/runners/connect" });
await once(wss, "listening");
const home = join(root, "home");
const workspace = join(home, "workspace");
await mkdir(join(workspace, "nested"), { recursive: true });
await mkdir(join(home, ".ssh"), { recursive: true });
await mkdir(join(home, ".happy-runner"), { recursive: true });
await writeFile(join(workspace, "readable"), "project-visible");
await writeFile(join(home, ".ssh", "secret"), "ssh-hidden");
await writeFile(join(home, ".happy-runner", "secret"), "runner-hidden");
await writeFile(
    join(workspace, "hello.c"),
    '#include <stdio.h>\nint main(void) { puts("compiled-visible"); return 0; }\n',
);
await promisify(execFile)("git", ["init", "--quiet", "--initial-branch=main", workspace]);
const target = http.createServer((request, response) => response.end("network-visible"));
target.listen(0, "127.0.0.1");
await once(target, "listening");
let child,
    socket,
    log = "";
const timeout = setTimeout(() => {
    console.error("Restricted CLI probe timed out.");
    child?.kill("SIGKILL");
    process.exitCode = 1;
    wss.close();
}, 60000);
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
                    ws.send(
                        encode({
                            type: "welcome",
                            protocol: 1,
                            instanceId: "restricted-cli-probe",
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
async function run(mode, command, { cwd, network = { egress: false, localBinding: false } } = {}) {
    const { header } = await rpc("shell.run", {
        computeId: "machine",
        options: { command, ...(cwd === undefined ? {} : { cwd }), permissions: { mode, network } },
    });
    assert(!header.error, JSON.stringify(header));
    return header.result.result;
}
try {
    child = spawn(
        resolve("target/debug/happy-agent"),
        ["runner", "--endpoint", `http://127.0.0.1:${wss.address().port}`],
        {
            env: {
                ...process.env,
                HOME: home,
                HAPPY_HOME_DIR: join(home, ".happy"),
                HAPPY_RUNNER_TOKEN: token,
            },
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    child.stdout.on("data", (bytes) => (log += bytes));
    child.stderr.on("data", (bytes) => (log += bytes));
    await ready;
    const created = await rpc("compute.create", {
        computeId: "machine",
        cwd: workspace,
        policy: { protectedProjectFiles: ["guarded.txt"], networkPolicyFiles: ["network.toml"] },
    });
    assert(!created.header.error, JSON.stringify(created.header));
    for (const mode of ["read_only", "workspace_write", "auto"]) {
        let result = await run(mode, "cat readable");
        assert.equal(result.exitCode, 0, JSON.stringify(result));
        assert.equal(result.stdout, "project-visible");
        result = await run(mode, `cat '${join(home, ".ssh", "secret")}'`);
        assert.notEqual(result.exitCode, 0, JSON.stringify(result));
        assert(!result.stdout.includes("ssh-hidden"));
        result = await run(mode, `cat '${join(home, ".happy-runner", "secret")}'`);
        assert.notEqual(result.exitCode, 0, JSON.stringify(result));
        assert(!result.stdout.includes("runner-hidden"));
        result = await run(
            mode,
            `curl --noproxy '*' --max-time 2 --fail --silent http://127.0.0.1:${target.address().port}/`,
        );
        assert.notEqual(result.exitCode, 0, JSON.stringify(result));
        for (const name of [
            "AGENTS.md",
            "AGENTS_SECURITY.md",
            "happy.toml",
            "guarded.txt",
            "network.toml",
        ]) {
            result = await run(mode, `printf changed > '../${name}'`, { cwd: "nested" });
            assert.notEqual(result.exitCode, 0, `${mode}/${name}: ${JSON.stringify(result)}`);
            await assert.rejects(access(join(workspace, name)));
        }
        result = await run(mode, `printf ${mode} > ${mode}.txt`);
        if (mode === "read_only") {
            assert.notEqual(result.exitCode, 0, JSON.stringify(result));
            await assert.rejects(access(join(workspace, `${mode}.txt`)));
        } else {
            assert.equal(result.exitCode, 0, JSON.stringify(result));
            assert.equal(await readFile(join(workspace, `${mode}.txt`), "utf8"), mode);
        }
        console.log(
            `${mode}: project read, sensitive/private reads denied, default network denied, absent protected paths stay absent from nested cwd, ordinary write mode passed.`,
        );
    }
    for (const [command, expected] of [
        [
            'node -e \'require("fs").writeFileSync("node-output","node-visible"); process.stdout.write("node-visible")\'',
            "node-visible",
        ],
        [
            'python3 -c \'from pathlib import Path; Path("python-output").write_text("python-visible"); print("python-visible",end="")\'',
            "python-visible",
        ],
        ["cc hello.c -o compiled-output && ./compiled-output", "compiled-visible\n"],
    ]) {
        const result = await run("workspace_write", command);
        assert.equal(result.exitCode, 0, JSON.stringify(result));
        assert.equal(result.stdout, expected);
    }
    let result = await run("workspace_write", "git status --short");
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert(result.stdout.includes("hello.c"));
    assert.equal(
        (await readFile(join(workspace, ".git", "HEAD"), "utf8")).trim(),
        "ref: refs/heads/main",
    );
    console.log(
        "Workspace write: Node, Python, a compiled C program, and Git status with protected Git controls passed.",
    );
    result = await run(
        "workspace_write",
        `curl --max-time 5 --fail --silent http://127.0.0.1:${target.address().port}/`,
        { network: { egress: true, localBinding: true, allowedHosts: ["127.0.0.1"] } },
    );
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(result.stdout, "network-visible");
    result = await run(
        "workspace_write",
        `curl --max-time 5 --fail --silent http://localhost:${target.address().port}/`,
        { network: { egress: true, localBinding: true, allowedHosts: ["localhost"] } },
    );
    assert.notEqual(result.exitCode, 0, JSON.stringify(result));
    assert(!result.stdout.includes("network-visible"));
    result = await run(
        "workspace_write",
        `curl --noproxy '*' --max-time 2 --fail --silent http://127.0.0.1:${target.address().port}/`,
        { network: { egress: true, localBinding: true, allowedHosts: ["127.0.0.1"] } },
    );
    assert.notEqual(result.exitCode, 0, JSON.stringify(result));
    result = await run(
        "workspace_write",
        'python3 -c \'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print("bound")\'',
        { network: { egress: false, localBinding: true } },
    );
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(result.stdout.trim(), "bound");
    console.log(
        "Managed literal allowlist HTTP proxy, private address behind hostname denial, direct bypass denial, and explicit loopback binding passed.",
    );
    await rpc("compute.dispose", { computeId: "machine" });
    child.kill("SIGTERM");
    const [code, signal] = await once(child, "exit");
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert(!log.includes(token));
} finally {
    clearTimeout(timeout);
    child?.kill("SIGKILL");
    socket?.terminate();
    await new Promise((ok) => wss.close(ok));
    await new Promise((ok) => target.close(ok));
    await rm(root, { recursive: true, force: true });
}
