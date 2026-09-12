import { mkdtemp, writeFile, readFile, stat, access } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve, isAbsolute } from "node:path";
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
const files = ["happy.toml", "AGENTS.md", "AGENTS_SECURITY.md", "mcp.toml", "keep.toml"];
const directories = [".git", ".agents", ".codex"];
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
assert.equal((await stat(policyRoot)).isDirectory(), true);
console.log(JSON.stringify({ fixture: root, policyRoot, shortPathCheck: true }));
assert.equal(spawnSync(git, ["init", root], { windowsHide: true }).status, 0);
await writeFile(join(root, "keep.toml"), "keep = 1\n");
const policy = {
    mode: "workspace_write",
    allowedReadPaths: [node, git],
    // Missing names must remain protected even when their spelling differs from
    // the filesystem casing of the existing workspace root.
    deniedWritePaths: [...files, ...directories]
        .map((n) => join(policyRoot, n).toUpperCase())
        .concat(outside),
    deniedWriteFilePaths: files.map((n) => join(policyRoot, n).toUpperCase()).concat(outside),
    network: { egress: false, localBinding: false },
};
const program = `const fs=require('fs');const cp=require('child_process');const result={};
const deny=(label,fn)=>{try{fn();result[label]='ALLOWED'}catch(e){result[label]=e.code}};
fs.writeFileSync('normal-file.txt','normal write works\\n');
deny('write',()=>fs.writeFileSync('happy.toml','BAD'));
deny('delete',()=>fs.unlinkSync('happy.toml'));
deny('rename',()=>fs.renameSync('happy.toml','moved.toml'));
fs.writeFileSync('replacement.tmp','BAD');
deny('replace',()=>fs.renameSync('replacement.tmp','happy.toml'));
deny('child',()=>fs.writeFileSync('.agents/payload.txt','BAD'));
deny('removeDirectory',()=>fs.rmdirSync('.codex'));
deny('renameDirectory',()=>fs.renameSync('.agents','moved-agents'));
result.empty=fs.readFileSync('happy.toml','utf8');
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
    for (const dir of directories)
        assert.equal((await stat(join(root, dir))).isDirectory(), true, `${dir} placeholder`);
    for (const key of [
        "write",
        "delete",
        "rename",
        "replace",
        "child",
        "removeDirectory",
        "renameDirectory",
    ])
        assert.match(result[key], /^(EACCES|EPERM)$/u, key + ": " + result[key]);
    assert.equal(result.empty, "");
    assert.equal(result.existing, "keep = 1\n");
    assert.match(result.git, /normal-file\.txt/);
    console.log(JSON.stringify({ fixture: root, result }));
}
await run();
await run();
for (const file of files) assert.equal((await stat(join(root, file))).isFile(), true, file);
for (const dir of directories) assert.equal((await stat(join(root, dir))).isDirectory(), true, dir);
await assert.rejects(access(outside), { code: "ENOENT" });
assert.equal(await readFile(join(root, "normal-file.txt"), "utf8"), "normal write works\n");
console.log(
    "PASS native placeholders: file types, existing bytes, write/delete/rename/replacement denial, normal writes, Git, repeated execution, and no outside materialization.",
);
