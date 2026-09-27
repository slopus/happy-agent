import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
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
const curl = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "curl.exe");
const state = process.env.HAPPY_WINDOWS_SANDBOX_HOME;
if (!state || !isAbsolute(state))
    throw new Error("Set HAPPY_WINDOWS_SANDBOX_HOME to the provisioned Happy sandbox state.");
const server = createServer((socket) => socket.end("HAPPY_NETWORK_CONTROL"));
await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
});
const port = server.address().port;
const offline = { egress: false, localBinding: false };
const online = { egress: true, localBinding: true };

// A refused sandbox connection must fail fast. A stalled one can wedge the host TCP stack,
// leaving even unrelated processes stuck in the kernel. Every probe that opens a socket
// therefore runs in a child process, and this verifier only waits on it with its own timer.
function start(label, network, file, args) {
    const policy = { mode: "read_only", allowedReadPaths: [node], network };
    const child = spawn(
        network === null ? file : bin,
        network === null
            ? args
            : [
                  "--policy",
                  JSON.stringify(policy),
                  "--state-dir",
                  state,
                  "--cwd",
                  cwd,
                  "--",
                  file,
                  ...args,
              ],
        { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout = [],
        stderr = [];
    child.stdout.on("data", (b) => stdout.push(b));
    child.stderr.on("data", (b) => stderr.push(b));
    const begun = Date.now();
    const result = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) =>
            resolve({
                label,
                code,
                ms: Date.now() - begun,
                stdout: Buffer.concat(stdout).toString(),
                stderr: Buffer.concat(stderr).toString(),
            }),
        );
    });
    // A spawn error before settle() must reach its catch, not crash as an unhandled rejection.
    result.catch(() => {});
    return { child, result, output: () => Buffer.concat(stdout).toString() };
}
async function settle(running, label, ms) {
    let timer;
    const expired = new Promise((_, reject) => {
        timer = setTimeout(() => {
            running.child.kill();
            reject(
                new Error(
                    `${label}: no result within ${ms} ms. The host network may be stalled; reboot before running anything else.`,
                ),
            );
        }, ms);
    });
    try {
        const result = await Promise.race([running.result, expired]);
        console.log(JSON.stringify(result));
        return result;
    } finally {
        clearTimeout(timer);
    }
}
async function run(label, network, file, args, ms = 15000) {
    return settle(start(label, network, file, args), label, ms);
}
const connect = `const n=require('net');const s=n.connect({host:'127.0.0.1',port:${port}});s.setTimeout(3000);s.on('data',b=>process.stdout.write(b));s.on('error',e=>process.stdout.write('BLOCKED:'+e.code));s.on('timeout',()=>{s.destroy();process.stdout.write('BLOCKED:TIMEOUT')});`;
async function assertHostAlive(label) {
    const result = await run(`host stays connected: ${label}`, null, node, ["-e", connect], 8000);
    assert.equal(result.stdout, "HAPPY_NETWORK_CONTROL", JSON.stringify(result));
}
// A blocked connection is an immediate error, never a 3 s socket timeout.
const refusedFast = /^BLOCKED:(?!TIMEOUT)/;
let failed = false;
try {
    // Absorb one-time setup refresh so the deadlines below measure only the command.
    const warm = await run(
        "sandbox warm-up",
        offline,
        node,
        ["-e", "process.stdout.write('READY')"],
        600000,
    );
    assert.equal(warm.stdout, "READY", JSON.stringify(warm));
    await assertHostAlive("before restricted networking");

    const nodeConnect = await run("restricted network cannot connect to loopback", offline, node, [
        "-e",
        connect,
    ]);
    assert.equal(nodeConnect.code, 0, JSON.stringify(nodeConnect));
    assert.match(nodeConnect.stdout, refusedFast);
    await assertHostAlive("after restricted Node connect");

    // curl.exe connects without an explicit bind, so Windows assigns the local port inside connect().
    // The loopback server proves the block; 192.0.2.1 exercises the non-loopback path for a stall
    // only, because a host without a route also answers it with exit 7.
    for (const target of [`http://127.0.0.1:${port}/`, "http://192.0.2.1/"]) {
        const label = `restricted implicit-bind connect to ${target} is refused`;
        const args = ["-sS", "--noproxy", "*", "--connect-timeout", "3", "-m", "5", target];
        const running = start(label, offline, curl, args);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await assertHostAlive(`while ${label}`);
        const refused = await settle(running, label, 15000);
        assert.equal(refused.code, 7, JSON.stringify(refused));
        await assertHostAlive(`after ${label}`);
    }

    const onlineConnect = await run(
        "explicit online policy can connect to loopback",
        online,
        node,
        ["-e", connect],
    );
    assert.equal(onlineConnect.stdout, "HAPPY_NETWORK_CONTROL", JSON.stringify(onlineConnect));

    const listen = (host) =>
        `const s=require('net').createServer();s.on('error',e=>process.stdout.write('BLOCKED:'+e.code));s.listen(0,${host},()=>{process.stdout.write('LISTENING');s.close()});`;
    for (const host of ["'127.0.0.1'", "undefined"]) {
        const bound = await run(`restricted local binding (${host})`, offline, node, [
            "-e",
            listen(host),
        ]);
        assert.match(bound.stdout, refusedFast, JSON.stringify(bound));
    }
    // Loopback only: a dual-stack listener would raise a firewall prompt for the online account.
    const onlineListen = await run("explicit online policy can listen", online, node, [
        "-e",
        listen("'127.0.0.1'"),
    ]);
    assert.equal(onlineListen.stdout, "LISTENING", JSON.stringify(onlineListen));

    // sendto without a bind also assigns the local port inside the send; nothing may arrive.
    const inbox = createSocket("udp4");
    const arrived = [];
    inbox.on("message", (message) => arrived.push(message.toString()));
    await new Promise((resolve, reject) => {
        inbox.once("error", reject);
        inbox.bind(0, "127.0.0.1", resolve);
    });
    for (const network of [offline, online]) {
        const label = `${network.egress ? "online" : "restricted"} UDP send`;
        const send = `const d=require('dgram').createSocket('udp4');d.send('${label}',${inbox.address().port},'127.0.0.1',e=>{process.stdout.write(e?'BLOCKED:'+e.code:'SENT');process.exit(0)});`;
        const sent = await run(label, network, node, ["-e", send]);
        assert.equal(sent.code, 0, JSON.stringify(sent));
        await new Promise((resolve) => setTimeout(resolve, 1000));
        assert.equal(arrived.includes(label), network.egress, JSON.stringify({ sent, arrived }));
        await assertHostAlive(`after ${label}`);
    }
    inbox.close();

    // The receive window covers a cold Node start for the host sender on a loaded runner.
    const receive =
        "const d=require('dgram').createSocket('udp4');d.on('error',e=>{process.stdout.write('BLOCKED:'+e.code);process.exit(0)});d.on('message',()=>{process.stdout.write('RECEIVED');process.exit(0)});d.bind(0,'127.0.0.1',()=>{process.stdout.write('PORT:'+d.address().port+';');setTimeout(()=>{process.stdout.write('NO_MESSAGE');process.exit(0)},10000)});";
    for (const [network, expected] of [
        [offline, /BLOCKED:(?!TIMEOUT)|NO_MESSAGE/],
        [online, /RECEIVED/],
    ]) {
        const label = `${network.egress ? "online" : "restricted"} UDP receive`;
        const running = start(label, network, node, ["-e", receive]);
        const deadline = Date.now() + 15000;
        let bound;
        while (!(bound = /PORT:(\d+);|BLOCKED:/.exec(running.output())) && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 100));
        if (bound?.[1]) {
            const send = `require('dgram').createSocket('udp4').send('x',${bound[1]},'127.0.0.1',()=>process.exit(0))`;
            const sent = await run(
                `host sends a datagram for ${label}`,
                null,
                node,
                ["-e", send],
                8000,
            );
            assert.equal(sent.code, 0, JSON.stringify(sent));
        }
        const received = await settle(running, label, 20000);
        assert.match(received.stdout, expected, JSON.stringify(received));
    }
    await assertHostAlive("after all restricted networking");
    console.log("PASS native network controls, positive controls and host liveness.");
} catch (error) {
    failed = true;
    console.error(error);
} finally {
    server.close();
}
// A child stuck in the kernel would keep this process alive; its failure is already reported.
process.exit(failed ? 1 : 0);
