// Protected project paths that exist stay immutable; protected paths that do not exist stay absent.
// The supervisor never materializes a placeholder to hang a deny ACE on. Removing a protected path
// a command creates is the caller's job (Happy Agent Compute's protected path monitor), so this
// check runs commands that leave missing protected paths alone and proves none appear.
import { mkdtemp, writeFile, readFile, stat, access } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
if (process.platform !== "win32") throw new Error("Native Windows verification requires Windows.");
const root = await mkdtemp(join(tmpdir(), "happy-placeholders-"));
const bin = fileURLToPath(
    new URL("../native/target/release/happy-agent-supervisor.exe", import.meta.url),
);
const node = process.execPath;
const foundGit = spawnSync("where.exe", ["git.exe"], { windowsHide: true, encoding: "utf8" });
if (foundGit.status !== 0) throw new Error("Git must be on PATH for this check.");
const git = foundGit.stdout.trim().split(/\r?\n/)[0];
const state = process.env.HAPPY_WINDOWS_SANDBOX_HOME;
if (!state || !isAbsolute(state))
    throw new Error("Set HAPPY_WINDOWS_SANDBOX_HOME to the provisioned Happy sandbox state.");
const outside = root + "-outside.toml";
const existing = ["keep.toml"];
const missingFiles = ["happy.toml", "AGENTS.md", "AGENTS_SECURITY.md", "mcp.toml"];
const missingDirectories = [".agents", ".codex"];
const shortPath = spawnSync(
    "powershell.exe",
    [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference = 'Stop'; (New-Object -ComObject Scripting.FileSystemObject).GetFolder('${root.replaceAll("'", "''")}').ShortPath`,
    ],
    { windowsHide: true, encoding: "utf8", timeout: 30_000 },
);
assert.equal(shortPath.status, 0, shortPath.stderr);
const policyRoot = shortPath.stdout.trim();
assert.ok(isAbsolute(policyRoot), "Windows returned an absolute short path");
console.log(JSON.stringify({ fixture: root, policyRoot, shortPathCheck: true }));
assert.equal(spawnSync(git, ["init", root], { windowsHide: true }).status, 0);
await writeFile(join(root, "keep.toml"), "keep = 1\n");
const policy = {
    mode: "workspace_write",
    allowedReadPaths: [node, git],
    // Protected names must hold even when their spelling differs from the filesystem casing of
    // the existing workspace root.
    deniedWritePaths: [...existing, ...missingFiles, ".git", ...missingDirectories]
        .map((n) => join(policyRoot, n).toUpperCase())
        .concat(outside),
    network: { egress: false, localBinding: false },
};
const program = `const fs=require('fs');const cp=require('child_process');const result={};
const deny=(label,fn)=>{try{fn();result[label]='ALLOWED'}catch(e){result[label]=e.code}};
result.absent=${JSON.stringify([...missingFiles, ...missingDirectories])}.filter((n)=>fs.existsSync(n));
fs.writeFileSync('normal-file.txt','normal write works\\n');
deny('write',()=>fs.writeFileSync('keep.toml','BAD'));
deny('delete',()=>fs.unlinkSync('keep.toml'));
deny('rename',()=>fs.renameSync('keep.toml','moved.toml'));
fs.writeFileSync('replacement.tmp','BAD');
deny('replace',()=>fs.renameSync('replacement.tmp','keep.toml'));
deny('child',()=>fs.writeFileSync('.git/payload.txt','BAD'));
deny('renameDirectory',()=>fs.renameSync('.git','moved-git'));
result.existing=fs.readFileSync('keep.toml','utf8');
result.git=cp.execFileSync(${JSON.stringify(git)},['-c',${JSON.stringify("safe.directory=" + root.replaceAll("\\", "/"))},'status','--short'],{encoding:'utf8',windowsHide:true});
console.log(JSON.stringify(result));`;
async function run() {
    const child = spawn(
        bin,
        [
            "--policy",
            JSON.stringify(policy),
            "--state-dir",
            state,
            "--cwd",
            root,
            "--",
            node,
            "-e",
            program,
        ],
        { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout = [],
        stderr = [];
    child.stdout.on("data", (b) => stdout.push(b));
    child.stderr.on("data", (b) => stderr.push(b));
    const timer = setTimeout(() => child.kill(), 60000);
    const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
    });
    clearTimeout(timer);
    const output = Buffer.concat(stdout).toString();
    const error = Buffer.concat(stderr).toString();
    assert.equal(code, 0, JSON.stringify({ code, output, error }));
    const result = JSON.parse(output);
    // Absent before the command, during it, and after it.
    assert.deepEqual(result.absent, [], "the supervisor materialized a protected path");
    for (const key of ["write", "delete", "rename", "replace", "child", "renameDirectory"])
        assert.match(result[key], /^(EACCES|EPERM)$/u, key + ": " + result[key]);
    assert.equal(result.existing, "keep = 1\n");
    assert.match(result.git, /normal-file\.txt/);
    console.log(JSON.stringify({ fixture: root, result }));
}
await run();
await run();
for (const name of [...missingFiles, ...missingDirectories])
    await assert.rejects(access(join(root, name)), { code: "ENOENT" }, name);
await assert.rejects(access(outside), { code: "ENOENT" });
assert.equal((await stat(join(root, ".git"))).isDirectory(), true);
assert.equal(await readFile(join(root, "keep.toml"), "utf8"), "keep = 1\n");
assert.equal(await readFile(join(root, "normal-file.txt"), "utf8"), "normal write works\n");
console.log(
    "PASS native protected paths: existing paths deny write/delete/rename/replacement, missing paths are never materialized, normal writes and Git work, repeated execution.",
);
