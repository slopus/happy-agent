import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertWindowsSystemImports } from "./assertWindowsSystemImports.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(readFileSync(join(packageRoot, "native/fff/source.json"), "utf8"));
if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("This native file-index builder targets Windows x64.");
const source = resolve(
    process.env.HAPPY_FFF_SOURCE_DIR ?? join(packageRoot, "../../.local/native-fff"),
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
    throw new Error("FFF source commit does not match its pin.");
if (run("git", ["status", "--porcelain", "--untracked-files=no"], source, true))
    throw new Error("FFF source has local modifications.");
// The default globset matcher is upstream-supported. Optional zlob requires Zig
// and links the MSVC runtime; Windows uses the GNU build without that optimization.
run("cargo", [
    "+" + metadata.toolchain,
    "build",
    "--locked",
    "--release",
    "--target",
    metadata.target,
    "-p",
    "fff-c",
]);
const binary = join(source, "target", metadata.target, "release", "fff_c.dll");
const imports = assertWindowsSystemImports(binary);
const destination = join(packageRoot, "native/target/win32-x64");
mkdirSync(destination, { recursive: true });
copyFileSync(binary, join(destination, "fff_c.dll"));
console.log(JSON.stringify({ binary: join(destination, "fff_c.dll"), imports }));
