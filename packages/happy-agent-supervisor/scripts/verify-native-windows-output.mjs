import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("Native Windows verification requires Windows.");
const state = process.env.HAPPY_WINDOWS_SANDBOX_HOME;
if (!state || !isAbsolute(state))
    throw new Error("Set HAPPY_WINDOWS_SANDBOX_HOME to the provisioned Happy sandbox state.");
const supervisor =
    process.env.HAPPY_WINDOWS_SUPERVISOR_BINARY ??
    fileURLToPath(new URL("../native/target/release/happy-agent-supervisor.exe", import.meta.url));
const cwd = await mkdtemp(join(tmpdir(), "happy-output-drain-"));
const chunks = 32768;
const expected = [Buffer.alloc(chunks * 4), Buffer.alloc(chunks * 4)];
for (let index = 0; index < chunks; index++) {
    expected[0].writeUInt32LE(index, index * 4);
    expected[1].writeUInt32LE(0xffffffff - index, index * 4);
}
const script = `const fs=require('node:fs');const out=Buffer.alloc(4),err=Buffer.alloc(4);for(let i=0;i<${chunks};i++){out.writeUInt32LE(i);err.writeUInt32LE(0xffffffff-i);fs.writeSync(1,out);fs.writeSync(2,err)}`;
const child = spawn(
    supervisor,
    [
        "--policy",
        JSON.stringify({
            mode: "read_only",
            allowedReadPaths: [process.execPath],
            network: { egress: false, localBinding: false },
        }),
        "--state-dir",
        state,
        "--cwd",
        cwd,
        "--",
        process.execPath,
        "-e",
        script,
    ],
    { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
);
const output = [[], []];
let paused = false;
let resumeTimer;
function receive(stream, chunk) {
    output[stream].push(chunk);
    if (paused) return;
    paused = true;
    // Deliberately exercise a slow consumer: bounded transport queues must
    // backpressure the producer rather than dropping thousands of tiny writes.
    child.stdout.pause();
    child.stderr.pause();
    resumeTimer = setTimeout(() => {
        child.stdout.resume();
        child.stderr.resume();
    }, 300);
}
child.stdout.on("data", (chunk) => receive(0, chunk));
child.stderr.on("data", (chunk) => receive(1, chunk));
const deadline = setTimeout(() => child.kill(), 60000);
try {
    const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
    });
    const actual = output.map((chunks) => Buffer.concat(chunks));
    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
    console.log(
        JSON.stringify({
            code,
            stdout: {
                actual: actual[0].length,
                expected: expected[0].length,
                sha256: digest(actual[0]),
                expectedSha256: digest(expected[0]),
            },
            stderr: {
                actual: actual[1].length,
                expected: expected[1].length,
                sha256: digest(actual[1]),
                expectedSha256: digest(expected[1]),
            },
        }),
    );
    assert.equal(code, 0, "Sandbox output transfer must finish successfully.");
    assert.deepEqual(actual[0], expected[0], "stdout lost or reordered bytes");
    assert.deepEqual(actual[1], expected[1], "stderr lost or reordered bytes");
    console.log(
        "PASS native output: 65,536 unbuffered tiny writes, bounded slow-consumer backpressure, exact stdout/stderr bytes, and complete exit drain with stdin open.",
    );
} finally {
    clearTimeout(deadline);
    clearTimeout(resumeTimer);
}

// ConPTY shares the same bounded Windows output driver but has one merged stream.
const ptyScript =
    "const fs=require('node:fs');fs.writeSync(1,'HAPPY_PTY_READY\\r\\n');process.stdin.once('data',data=>{fs.writeSync(1,'HAPPY_PTY_ECHO:'+data.toString().trim()+'\\r\\n');process.exit(7)});";
const ptyChild = spawn(
    supervisor,
    [
        "--policy",
        JSON.stringify({
            mode: "read_only",
            allowedReadPaths: [process.execPath],
            network: { egress: false, localBinding: false },
        }),
        "--state-dir",
        state,
        "--cwd",
        cwd,
        "--tty",
        "--",
        process.execPath,
        "-e",
        ptyScript,
    ],
    { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
);
let ptyOutput = "";
let ptyErrors = "";
let ptyInputSent = false;
ptyChild.stdout.on("data", (chunk) => {
    ptyOutput += chunk.toString();
    if (!ptyInputSent && ptyOutput.includes("HAPPY_PTY_READY")) {
        ptyInputSent = true;
        ptyChild.stdin.write("native-ping\n");
    }
});
ptyChild.stderr.on("data", (chunk) => {
    ptyErrors += chunk.toString();
});
const ptyDeadline = setTimeout(() => ptyChild.kill(), 20000);
try {
    const code = await new Promise((resolve, reject) => {
        ptyChild.once("error", reject);
        ptyChild.once("close", resolve);
    });
    assert.equal(code, 7, "Restricted PTY must preserve the child exit code.");
    assert.ok(
        ptyOutput.includes("HAPPY_PTY_ECHO:native-ping"),
        "Restricted PTY did not roundtrip stdin.",
    );
    assert.equal(ptyErrors, "", "Restricted PTY must merge child output into its stdout stream.");
    console.log(
        "PASS actual restricted Windows PTY: stdin roundtrip, merged output, and exact child exit code.",
    );
} finally {
    clearTimeout(ptyDeadline);
}
