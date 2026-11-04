import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

// Every sandboxed command logs a sandbox account on through LSASS. Windows keeps a logon
// session, and LSASS keeps handles for it, until every token of that session is closed, so a
// launch path that leaks one token, profile, or policy handle grows LSASS without bound while
// the agent repeats it. This measures LSASS across repeated launches and fails on steady growth.

if (process.platform !== "win32") throw new Error("Native Windows verification requires Windows.");
const state = process.env.HAPPY_WINDOWS_SANDBOX_HOME;
if (!state || !isAbsolute(state))
    throw new Error("Select an already provisioned Happy sandbox state.");
const supervisor =
    process.env.HAPPY_WINDOWS_SUPERVISOR ??
    fileURLToPath(new URL("../native/target/release/happy-agent-supervisor.exe", import.meta.url));
const launches = Number(process.env.HAPPY_LSASS_LAUNCHES ?? 150);
// Allowed LSASS growth per launch once the run has settled. A leaked logon session costs
// several handles each, while ordinary LSASS churn stays in the tens across the whole run.
const allowedPerLaunch = Number(process.env.HAPPY_LSASS_ALLOWED_PER_LAUNCH ?? 0.25);
const settleMs = Number(process.env.HAPPY_LSASS_SETTLE_MS ?? 30_000);

function powershell(command) {
    // A PowerShell 7 parent can inject incompatible modules into Windows PowerShell.
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
    const result = spawnSync(
        "powershell.exe",
        [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(command, "utf16le").toString("base64"),
        ],
        { windowsHide: true, encoding: "utf8", timeout: 600_000, env },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

function sample() {
    const output = powershell(
        `$l = Get-Process -Name lsass; $s = Get-Process -Id ${process.pid}; ` +
            `$sessions = @(Get-CimInstance Win32_LogonSession).Count; ` +
            `@{ lsass = $l.HandleCount; lsassMemory = $l.PrivateMemorySize64; caller = $s.HandleCount; logonSessions = $sessions } | ConvertTo-Json -Compress`,
    );
    return JSON.parse(output);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const cwd = await mkdtemp(join(tmpdir(), "happy-lsass-"));

const sandboxedArguments = () => [
    "--no-provision",
    "--state-dir",
    state,
    "--cwd",
    cwd,
    "--policy",
    JSON.stringify({ mode: "read_only", network: { egress: false, localBinding: false } }),
    "--",
    "C:\\Windows\\System32\\cmd.exe",
    "/d",
    "/c",
    "exit 0",
];

/** Several projects scanning at once, as Git tracking does across open projects. */
async function sandboxedConcurrently(count, parallel) {
    let next = 0;
    async function worker() {
        while (next < count) {
            next += 1;
            await new Promise((resolve, reject) => {
                const child = spawn(supervisor, sandboxedArguments(), {
                    cwd,
                    windowsHide: true,
                    stdio: "ignore",
                });
                child.on("error", reject);
                child.on("exit", (code) =>
                    code === 0 ? resolve() : reject(new Error(`Sandboxed command exited ${code}`)),
                );
            });
        }
    }
    await Promise.all(Array.from({ length: parallel }, worker));
}

function sandboxed() {
    const result = spawnSync(
        supervisor,
        [
            "--no-provision",
            "--state-dir",
            state,
            "--cwd",
            cwd,
            "--policy",
            JSON.stringify(policy),
            "--",
            "C:\\Windows\\System32\\cmd.exe",
            "/d",
            "/c",
            "exit 0",
        ],
        { cwd, windowsHide: true, encoding: "utf8", timeout: 60_000, stdio: "pipe" },
    );
    assert.equal(
        result.status,
        0,
        JSON.stringify({
            status: result.status,
            stderr: result.stderr,
            error: result.error?.message,
        }),
    );
}

function setupStatus() {
    const result = spawnSync(supervisor, ["--setup-status", "--state-dir", state], {
        windowsHide: true,
        encoding: "utf8",
        timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
}

async function phase(name, run, all) {
    const before = sample();
    const started = Date.now();
    if (all !== undefined) await all();
    else for (let index = 0; index < launches; index++) run();
    const elapsedMs = Date.now() - started;
    const after = sample();
    await sleep(settleMs);
    const settled = sample();
    const growth = settled.lsass - before.lsass;
    const report = {
        phase: name,
        launches,
        elapsedMs,
        lsassBefore: before.lsass,
        lsassAfter: after.lsass,
        lsassSettled: settled.lsass,
        lsassGrowth: growth,
        lsassGrowthPerLaunch: Number((growth / launches).toFixed(3)),
        lsassMemoryGrowth: settled.lsassMemory - before.lsassMemory,
        logonSessionsBefore: before.logonSessions,
        logonSessionsSettled: settled.logonSessions,
        callerHandleGrowth: settled.caller - before.caller,
    };
    console.log(JSON.stringify(report));
    return report;
}

const failures = [];
try {
    // Warm once so one-time ACLs, helper copies, and the private desktop are in the baseline.
    sandboxed();
    const idleBefore = sample();
    await sleep(settleMs);
    const idleAfter = sample();
    console.log(
        JSON.stringify({
            phase: "idle",
            lsassBefore: idleBefore.lsass,
            lsassAfter: idleAfter.lsass,
        }),
    );
    for (const report of [
        await phase("setup-status", setupStatus),
        await phase("sandboxed-command", sandboxed),
        await phase("sandboxed-command-8-parallel", undefined, () =>
            sandboxedConcurrently(launches, 8),
        ),
    ]) {
        if (report.lsassGrowthPerLaunch > allowedPerLaunch) {
            failures.push(
                `${report.phase}: LSASS grew by ${report.lsassGrowth} handles over ${launches} launches`,
            );
        }
        if (
            report.logonSessionsSettled - report.logonSessionsBefore >
            launches * allowedPerLaunch
        ) {
            failures.push(
                `${report.phase}: ${report.logonSessionsSettled - report.logonSessionsBefore} logon sessions outlived their commands`,
            );
        }
    }
} finally {
    await rm(cwd, { recursive: true, force: true });
}
if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
}
