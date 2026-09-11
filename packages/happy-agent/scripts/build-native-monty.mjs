import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(readFileSync(join(packageRoot, "native/monty/source.json"), "utf8"));
if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("This builder targets Windows x64.");
const source = resolve(
    process.env.HAPPY_MONTY_SOURCE_DIR ?? join(packageRoot, "../../.local/native-monty"),
);
function run(command, args, cwd = source, capture = false) {
    const result = spawnSync(command, args, {
        cwd,
        windowsHide: true,
        encoding: "utf8",
        stdio: capture ? "pipe" : "inherit",
        env: { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "2" },
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
        throw new Error(`${command} failed (${result.status}): ${result.stderr ?? ""}`);
    return result.stdout?.trim();
}
if (!existsSync(join(source, ".git"))) {
    if (existsSync(source)) throw new Error(`Expected an empty source destination: ${source}`);
    mkdirSync(dirname(source), { recursive: true });
    run(
        "git",
        ["clone", "--depth", "1", "--branch", metadata.tag, metadata.repository, source],
        dirname(source),
    );
}
if (run("git", ["rev-parse", "HEAD"], source, true) !== metadata.commit)
    throw new Error("Monty source commit does not match its pin.");
if (run("git", ["status", "--porcelain", "--untracked-files=no"], source, true))
    throw new Error("Monty source has local modifications.");
run("cargo", [
    "+" + metadata.toolchain,
    "build",
    "--locked",
    "--release",
    "--target",
    metadata.target,
    "-p",
    "monty-runtime",
    "--no-default-features",
]);
const binary = join(source, "target", metadata.target, "release", "monty.exe");
const pe = readFileSync(binary);
const signature = pe.readUInt32LE(0x3c);
if (pe.toString("ascii", signature, signature + 4) !== "PE\0\0")
    throw new Error("Monty is not a PE executable.");
const optional = signature + 24;
if (pe.readUInt16LE(optional) !== 0x20b) throw new Error("Monty is not a Windows x64 executable.");
const sections = [];
const table = optional + pe.readUInt16LE(signature + 20);
for (let i = 0; i < pe.readUInt16LE(signature + 6); i++) {
    const at = table + i * 40;
    sections.push({
        rva: pe.readUInt32LE(at + 12),
        size: Math.max(pe.readUInt32LE(at + 8), pe.readUInt32LE(at + 16)),
        offset: pe.readUInt32LE(at + 20),
    });
}
function offset(rva) {
    const section = sections.find((s) => rva >= s.rva && rva < s.rva + s.size);
    if (!section) throw new Error("Invalid PE import address.");
    return section.offset + rva - section.rva;
}
const imports = [];
for (let at = offset(pe.readUInt32LE(optional + 120)); pe.readUInt32LE(at + 12); at += 20) {
    const name = offset(pe.readUInt32LE(at + 12));
    imports.push(pe.toString("ascii", name, pe.indexOf(0, name)));
}
const system = new Set([
    "kernel32.dll",
    "ntdll.dll",
    "msvcrt.dll",
    "bcrypt.dll",
    "bcryptprimitives.dll",
    "advapi32.dll",
    "user32.dll",
    "userenv.dll",
    "ws2_32.dll",
    "ole32.dll",
    "shell32.dll",
    "secur32.dll",
    "iphlpapi.dll",
    "crypt32.dll",
    "dbghelp.dll",
    "version.dll",
    "rpcrt4.dll",
]);
const external = imports.filter(
    (name) => !system.has(name.toLowerCase()) && !/^(api-ms-win-|ext-ms-win-)/i.test(name),
);
if (external.length) throw new Error(`Monty still needs external DLLs: ${external.join(", ")}`);
const output = join(packageRoot, "native/target/win32-x64");
mkdirSync(output, { recursive: true });
copyFileSync(binary, join(output, "monty.exe"));
console.log(JSON.stringify({ binary: join(output, "monty.exe"), bytes: pe.length, imports }));
