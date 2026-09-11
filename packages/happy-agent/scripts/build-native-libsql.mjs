import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadataRoot = join(packageRoot, "native", "libsql");
const metadata = JSON.parse(readFileSync(join(metadataRoot, "source.json"), "utf8"));
if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("This native database builder targets Windows x64.");
}
const cache = resolve(
    process.env.HAPPY_LIBSQL_BUILD_DIR ?? join(packageRoot, "../../.local/native-libsql"),
);
const source = join(cache, "libsql-js");
const crate = join(cache, `libsql-${metadata.crateVersion}`);
mkdirSync(cache, { recursive: true });
function run(command, args, cwd = source, options = {}) {
    const result = spawnSync(command, args, {
        cwd,
        stdio: "inherit",
        windowsHide: true,
        ...options,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed with ${result.status}`);
    return result;
}
// The encrypted SQLite dependency invokes these native build tools itself.
// PowerShell aliases (notably cp) cannot satisfy a child process executable lookup.
for (const executable of ["git", "cargo", "cp", "cmake", "gcc", "g++", "mingw32-make"]) {
    const result = spawnSync("where.exe", [executable], { windowsHide: true, stdio: "pipe" });
    if (result.status !== 0) {
        throw new Error(
            "Missing native build executable " +
                executable +
                ". Add Git for Windows usr/bin, CMake, and the MinGW compiler tools to PATH. " +
                "These are build dependencies only; the distributed Happy Agent does not require them.",
        );
    }
}
function patch(directory, name) {
    const path = join(metadataRoot, name);
    const applied = spawnSync("git", ["apply", "--reverse", "--check", path], {
        cwd: directory,
        windowsHide: true,
        stdio: "pipe",
    });
    if (applied.status === 0) return;
    run("git", ["apply", "--check", path], directory);
    run("git", ["apply", path], directory);
}
if (!existsSync(join(source, ".git"))) {
    if (existsSync(source)) throw new Error(`Expected an empty source destination: ${source}`);
    run(
        "git",
        [
            "clone",
            "--config",
            "core.autocrlf=false",
            "--filter=blob:none",
            "--no-checkout",
            metadata.repository,
            source,
        ],
        cache,
    );
    run("git", ["checkout", "--detach", metadata.commit]);
}
const head = run("git", ["rev-parse", "HEAD"], source, {
    stdio: "pipe",
    encoding: "utf8",
}).stdout.trim();
if (head !== metadata.commit)
    throw new Error(`Expected libSQL source ${metadata.commit}, got ${head}`);
if (!existsSync(crate)) {
    const response = await fetch(
        `https://static.crates.io/crates/libsql/libsql-${metadata.crateVersion}.crate`,
    );
    if (!response.ok) throw new Error(`libSQL source download failed: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(archive).digest("hex") !== metadata.crateSha256) {
        throw new Error("libSQL source archive checksum mismatch.");
    }
    const archivePath = join(cache, "libsql.crate");
    writeFileSync(archivePath, archive);
    run(
        join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"),
        ["-xf", archivePath, "-C", cache],
        cache,
    );
}
patch(source, "binding.patch");
// An extracted crate has no .git directory. When its cache lives inside this
// repository, `git apply` otherwise finds the parent worktree and silently
// skips every crate-relative path (even --reverse --check returns success).
// Give this verified source archive its own patch root before applying it.
if (!existsSync(join(crate, ".git"))) run("git", ["init", "--quiet"], crate);
patch(crate, "connection.patch");
if (
    !readFileSync(join(crate, "src/local/connection.rs"), "utf8").includes(
        "self.raw = std::ptr::null_mut();",
    )
)
    throw new Error("The native libsql connection teardown patch was not applied.");
copyFileSync(join(metadataRoot, "Cargo.lock"), join(source, "Cargo.lock"));
run(
    "cargo",
    [
        "+" + metadata.toolchain,
        "build",
        "--release",
        "--locked",
        "--config",
        `patch.crates-io.libsql.path=${JSON.stringify(crate.replaceAll("\\", "/"))}`,
    ],
    source,
    {
        env: {
            ...process.env,
            CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "2",
            CMAKE_GENERATOR: process.env.CMAKE_GENERATOR ?? "MinGW Makefiles",
        },
    },
);
const output = join(packageRoot, "native", "target", "win32-x64");
mkdirSync(output, { recursive: true });
const binary = join(output, "libsql.node");
copyFileSync(join(source, "target", "release", "libsql_js.dll"), binary);
const require = createRequire(import.meta.url);
const binding = require(binary);
if (typeof binding.statementFinalize !== "function" || typeof binding.rowsClose !== "function") {
    throw new Error("The built database binding is missing deterministic disposal.");
}
if (process.argv.includes("--install-development-binding")) {
    const modulesRequire = createRequire(join(packageRoot, "../happy-agent-modules/package.json"));
    const clientRequire = createRequire(modulesRequire.resolve("@libsql/client"));
    const libsqlRequire = createRequire(clientRequire.resolve("libsql"));
    copyFileSync(binary, libsqlRequire.resolve("@libsql/win32-x64-msvc"));
    console.log("Installed the corrected native database binding for local development.");
}
console.log(`Built ${binary}`);
