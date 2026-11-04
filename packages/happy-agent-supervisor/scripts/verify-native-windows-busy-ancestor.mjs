import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Happy Agent and most terminals sit in the user profile. A process's current
// directory handle does not share delete, so a grant that asks for more than
// READ_CONTROL | WRITE_DAC on a busy project ancestor fails with a sharing
// violation and every sandboxed command exits 125 (slopus/happy-agent#73, #75).

if (process.platform !== "win32") throw new Error("Native Windows verification requires Windows.");
const state = process.env.HAPPY_WINDOWS_SANDBOX_HOME;
if (!state || !isAbsolute(state))
    throw new Error("Select an already provisioned Happy sandbox state.");
const supervisor = fileURLToPath(
    new URL("../native/target/release/happy-agent-supervisor.exe", import.meta.url),
);
// Fresh ancestors under the profile have no Happy traversal ACE yet, like the
// profile directory of a user whose first command is still pending.
const root = await mkdtemp(join(homedir(), "happy-busy-ancestor-"));
const holders = [];

function holdCurrentDirectory(directory) {
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        cwd: directory,
        windowsHide: true,
        stdio: "ignore",
    });
    holders.push(holder);
    return new Promise((resolveSpawn, reject) => {
        holder.once("spawn", resolveSpawn);
        holder.once("error", reject);
    });
}

function descriptor(path) {
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    const command = `$ErrorActionPreference = 'Stop'; (Get-Acl -LiteralPath ${quote(path)}).Sddl`;
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
        { windowsHide: true, encoding: "utf8", timeout: 30_000, env },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

function daclControl(sddl) {
    return /D:([A-Z]*)/.exec(sddl)?.[1] ?? "";
}

function runIn(cwd) {
    const policy = {
        mode: "workspace_write",
        allowedReadPaths: [process.execPath],
        network: { egress: false, localBinding: false },
    };
    const args = [
        "--no-provision",
        "--state-dir",
        state,
        "--cwd",
        cwd,
        "--policy",
        JSON.stringify(policy),
        "--",
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync('proof.txt','ok');process.stdout.write('ran')",
    ];
    return new Promise((resolveRun) => {
        const child = spawn(supervisor, args, {
            cwd,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
        const timer = setTimeout(() => child.kill(), 120_000);
        child.once("close", (status) => {
            clearTimeout(timer);
            resolveRun({ status, stdout, stderr });
        });
    });
}

async function setupLogTail() {
    const directory = join(state, ".sandbox");
    const logs = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith(".log"));
    if (logs.length === 0) return "";
    const newest = logs.sort().at(-1);
    return (await readFile(join(directory, newest), "utf8")).split(/\r?\n/).slice(-20).join("\n");
}

async function assertRan(result, label) {
    if (result.status !== 0) console.error(`${label} setup log:\n${await setupLogTail()}`);
    assert.equal(result.status, 0, `${label}: ${JSON.stringify(result)}`);
    assert.equal(result.stdout, "ran", label);
}

try {
    // The user's own shell or the daemon in the profile itself.
    await holdCurrentDirectory(homedir());

    const busy = join(root, "busy");
    const project = join(busy, "project");
    const sibling = join(busy, "sibling");
    await mkdir(project, { recursive: true });
    await mkdir(sibling);
    await writeFile(join(sibling, "existing.txt"), "existing");
    await holdCurrentDirectory(busy);
    const busyBefore = descriptor(busy);
    const siblingBefore = descriptor(sibling);
    const existingBefore = descriptor(join(sibling, "existing.txt"));

    await assertRan(await runIn(project), "first command below a busy ancestor");

    const busyAfter = descriptor(busy);
    assert.notEqual(busyAfter, busyBefore, "the busy ancestor received its traversal ACE");
    assert.equal(
        daclControl(busyAfter),
        daclControl(busyBefore),
        "the ancestor keeps its inheritance flags",
    );
    assert.equal(descriptor(sibling), siblingBefore, "the grant must not propagate to siblings");
    assert.equal(
        descriptor(join(sibling, "existing.txt")),
        existingBefore,
        "the grant must not propagate to existing files",
    );

    // An already granted ancestor is reused, and concurrent first commands in
    // new projects below other busy ancestors all succeed.
    await assertRan(await runIn(project), "second command below the same busy ancestor");
    assert.equal(descriptor(busy), busyAfter, "an existing grant is reused unchanged");
    const parallel = [];
    for (let index = 0; index < 3; index++) {
        const parent = join(root, `parallel-${index}`);
        await mkdir(join(parent, "project"), { recursive: true });
        await holdCurrentDirectory(parent);
        parallel.push(runIn(join(parent, "project")));
    }
    for (const [index, result] of (await Promise.all(parallel)).entries())
        await assertRan(result, `concurrent command ${index}`);

    console.log(
        JSON.stringify({
            busyAncestors: 5,
            commands: 5,
            propagation: "none",
            inheritanceFlags: "preserved",
        }),
    );
} finally {
    for (const holder of holders) holder.kill();
    await Promise.all(
        holders.map((holder) =>
            holder.exitCode === null && holder.signalCode === null
                ? new Promise((resolveExit) => holder.once("exit", resolveExit))
                : undefined,
        ),
    );
    assert.ok(resolve(root).startsWith(resolve(homedir()) + "\\happy-busy-ancestor-"));
    await rm(root, { recursive: true, force: true });
}
