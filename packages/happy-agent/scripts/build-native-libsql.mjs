import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadataRoot = join(packageRoot, "native", "libsql");
const metadata = JSON.parse(readFileSync(join(metadataRoot, "source.json"), "utf8"));
const key = `${process.platform}-${process.arch}`;
const library = {
    "win32-x64": "libsql_js.dll",
    "darwin-arm64": "liblibsql_js.dylib",
    "darwin-x64": "liblibsql_js.dylib",
    "linux-arm64": "liblibsql_js.so",
    "linux-x64": "liblibsql_js.so",
}[key];
if (!library) throw new Error(`Unsupported native database build target: ${key}`);
const windows = process.platform === "win32";
const toolchain = windows ? metadata.windowsToolchain : metadata.toolchain;
const cache = resolve(
    process.env.HAPPY_LIBSQL_BUILD_DIR ?? join(packageRoot, `../../.local/native-libsql/${key}`),
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
for (const executable of [
    "git",
    "cargo",
    "cp",
    "cmake",
    "gcc",
    "g++",
    windows ? "mingw32-make" : "make",
]) {
    const result = spawnSync(windows ? "where.exe" : "which", [executable], {
        windowsHide: true,
        stdio: "pipe",
    });
    if (result.status !== 0) {
        throw new Error(
            "Missing native build executable " +
                executable +
                (windows
                    ? ". Add Git for Windows usr/bin, CMake, and the MinGW compiler tools to PATH. "
                    : ". Install Git, Rust, CMake, make, and the system C/C++ compiler. ") +
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
        windows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar",
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
        "+" + toolchain,
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
            ...(windows
                ? { CMAKE_GENERATOR: process.env.CMAKE_GENERATOR ?? "MinGW Makefiles" }
                : {}),
        },
    },
);
const output = join(packageRoot, "native", "target", key);
mkdirSync(output, { recursive: true });
const binary = join(output, "libsql.node");
copyFileSync(join(source, "target", "release", library), binary);
const require = createRequire(import.meta.url);
const binding = require(binary);
if (typeof binding.statementFinalize !== "function" || typeof binding.rowsClose !== "function") {
    throw new Error("The built database binding is missing deterministic disposal.");
}
if (process.argv.includes("--install-development-binding")) {
    const modulesRequire = createRequire(join(packageRoot, "../happy-agent-modules/package.json"));
    const clientRequire = createRequire(modulesRequire.resolve("@libsql/client"));
    const libsqlRequire = createRequire(clientRequire.resolve("libsql"));
    const suffix = windows ? "-msvc" : process.platform === "linux" ? "-gnu" : "";
    copyFileSync(binary, libsqlRequire.resolve(`@libsql/${key}${suffix}`));
    console.log("Installed the corrected native database binding for local development.");
}
console.log(`Built ${binary}`);
