import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
if (process.platform !== "win32") throw new Error("Native Windows verification requires Windows.");
const cwd = await mkdtemp(join(tmpdir(), "happy-network-"));
const bin = fileURLToPath(
    new URL("../native/target/release/happy-agent-supervisor.exe", import.meta.url),
);
const node = process.execPath;
const state = process.env.HAPPY_WINDOWS_SANDBOX_HOME;
if (!state || !isAbsolute(state))
    throw new Error("Set HAPPY_WINDOWS_SANDBOX_HOME to the provisioned Happy sandbox state.");
const server = createServer((socket) => socket.end("HAPPY_NETWORK_CONTROL"));
await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
});
const port = server.address().port;
async function run(label, network, script) {
    const policy = { mode: "read_only", allowedReadPaths: [node], network };
    const command = network === null ? node : bin;
    const args =
        network === null
            ? ["-e", script]
            : [
                  "--policy",
                  JSON.stringify(policy),
                  "--state-dir",
                  state,
                  "--cwd",
                  cwd,
                  "--",
                  node,
                  "-e",
                  script,
              ];
    const child = spawn(command, args, {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [],
        stderr = [];
    child.stdout.on("data", (b) => stdout.push(b));
    child.stderr.on("data", (b) => stderr.push(b));
    const timer = setTimeout(() => child.kill(), 120000);
    const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
    });
    clearTimeout(timer);
    const result = {
        label,
        code,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
    };
    console.log(JSON.stringify(result));
    assert.equal(code, 0, JSON.stringify(result));
    return result.stdout;
}
const connect = `const n=require('net');const s=n.connect({host:'127.0.0.1',port:${port}});s.setTimeout(3000);s.on('data',b=>process.stdout.write(b));s.on('error',e=>process.stdout.write('BLOCKED:'+e.code));s.on('timeout',()=>{s.destroy();process.stdout.write('BLOCKED:TIMEOUT')});`;
try {
    assert.equal(
        await run("positive control outside sandbox", null, connect),
        "HAPPY_NETWORK_CONTROL",
    );
    assert.match(
        await run(
            "restricted network cannot connect to loopback",
            { egress: false, localBinding: false },
            connect,
        ),
        /^BLOCKED:/,
    );
    assert.equal(
        await run(
            "explicit online policy can connect to loopback",
            { egress: true, localBinding: true },
            connect,
        ),
        "HAPPY_NETWORK_CONTROL",
    );
    const bind =
        "const s=require('net').createServer();s.on('error',e=>process.stdout.write('BLOCKED:'+e.code));s.listen(0,'127.0.0.1',()=>{process.stdout.write('LISTENING');s.close()});";
    assert.match(
        await run("restricted local binding", { egress: false, localBinding: false }, bind),
        /^BLOCKED:/,
    );
    console.log("PASS native network controls and positive controls.");
} finally {
    await new Promise((resolve) => server.close(resolve));
}
