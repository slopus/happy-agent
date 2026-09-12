import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("Native Windows verification requires Windows.");
const state = process.env.HAPPY_WINDOWS_SANDBOX_HOME;
if (!state || !isAbsolute(state))
    throw new Error("Select an already provisioned Happy sandbox state.");
const supervisor = fileURLToPath(
    new URL("../native/target/release/happy-agent-supervisor.exe", import.meta.url),
);
const cwd = await mkdtemp(join(tmpdir(), "happy-stability-"));
const outside = cwd + "-outside.txt";
const protectedPath = join(cwd, ".agents");
await writeFile(outside, "outside remains protected");

function run(mode) {
    const policy = {
        mode,
        allowedReadPaths: [process.execPath],
        deniedWritePaths: [protectedPath, outside],
        network: { egress: false, localBinding: false },
    };
    const program = `const fs=require('node:fs'),a=require('node:assert/strict');
        const denied=p=>a.throws(()=>fs.writeFileSync(p,'forbidden'));
        denied(${JSON.stringify(outside)});
        denied(${JSON.stringify(join(state, "unexpected-command-write.txt"))});
        denied('.agents/payload.txt');
        ${mode === "workspace_write" ? "fs.writeFileSync('proof.txt','allowed');" : "denied('proof.txt');"}
        process.stdout.write('enforced');`;
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
            process.execPath,
            "-e",
            program,
        ],
        {
            cwd,
            windowsHide: true,
            encoding: "utf8",
            timeout: 60_000,
            stdio: ["ignore", "pipe", "pipe"],
        },
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
    assert.equal(result.stdout, "enforced");
}

function descriptors() {
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    const command = `@(${[state, outside, protectedPath].map(quote).join(",")}) | ForEach-Object { (Get-Acl -LiteralPath $_).Sddl } | ConvertTo-Json -Compress`;
    const result = spawnSync(
        "powershell.exe",
        [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(command, "utf16le").toString("base64"),
        ],
        { windowsHide: true, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

try {
    // Warm both modes so the baseline includes legitimate one-time project ACLs.
    run("workspace_write");
    run("read_only");
    const before = descriptors();
    const registry = await readFile(join(state, "cap_sid"));
    for (let index = 0; index < 64; index++) run(index % 2 === 0 ? "workspace_write" : "read_only");
    assert.deepEqual(
        descriptors(),
        before,
        "Repeated commands must not accumulate permanent ACL entries",
    );
    assert.deepEqual(
        await readFile(join(state, "cap_sid")),
        registry,
        "Command scratch paths must not grow the capability registry",
    );
    assert.equal(await readFile(outside, "utf8"), "outside remains protected");
    assert.equal(await readFile(join(cwd, "proof.txt"), "utf8"), "allowed");
    console.log(
        JSON.stringify({
            commands: 66,
            aclGrowth: 0,
            capabilityRegistryGrowth: 0,
            workspaceWrites: "enforced",
            readOnly: "enforced",
            outsideWrites: "denied",
            protectedWrites: "denied",
        }),
    );
} finally {
    assert.ok(resolve(cwd).startsWith(resolve(tmpdir()) + "\\happy-stability-"));
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { force: true });
}
