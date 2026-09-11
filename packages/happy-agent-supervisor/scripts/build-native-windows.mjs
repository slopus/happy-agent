import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(readFileSync(join(packageRoot, "native/windows/source.json"), "utf8"));
if (process.platform !== "win32") throw new Error("This builder targets native Windows.");
const source = resolve(
    process.env.HAPPY_CODEX_SOURCE_DIR ?? join(packageRoot, "../../.local/windows-codex-source"),
);
const patch = join(packageRoot, "native/windows/happy.patch");
function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: source,
        stdio: "inherit",
        windowsHide: true,
        ...options,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
    return result;
}
if (!existsSync(join(source, ".git"))) {
    if (existsSync(source))
        throw new Error(`Source directory exists without a Git checkout: ${source}`);
    mkdirSync(dirname(source), { recursive: true });
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
        {
            cwd: dirname(source),
        },
    );
    run("git", ["sparse-checkout", "set", "codex-rs"]);
    run("git", ["checkout", "--detach", metadata.commit]);
}
const head = run("git", ["rev-parse", "HEAD"], { stdio: "pipe", encoding: "utf8" }).stdout.trim();
if (head !== metadata.commit)
    throw new Error(`Sandbox source must be pinned to ${metadata.commit}, got ${head}`);
const alreadyApplied =
    spawnSync("git", ["apply", "--reverse", "--check", patch], {
        cwd: source,
        windowsHide: true,
        stdio: "pipe",
    }).status === 0;
if (!alreadyApplied) {
    run("git", ["apply", "--check", patch]);
    run("git", ["apply", patch]);
}
if (
    !readFileSync(join(source, "codex-rs/windows-sandbox-rs/src/setup.rs"), "utf8").includes(
        `pub const SETUP_VERSION: u32 = ${metadata.setupVersion};`,
    )
)
    throw new Error("Happy sandbox setupVersion metadata does not match the patched source");
copyFileSync(
    join(packageRoot, "native/windows/main.rs"),
    join(source, "codex-rs/windows-sandbox-rs/src/bin/happy_main.rs"),
);
const profile = process.argv.includes("--debug") ? "debug" : "release";
const cargoRoot = join(source, "codex-rs");
run(
    "cargo",
    [
        "+" + metadata.buildToolchain,
        "build",
        "--manifest-path",
        join(cargoRoot, "windows-sandbox-rs/Cargo.toml"),
        "--locked",
        "--bin",
        "happy-agent-supervisor",
        "--bin",
        "happy-sandbox-runner",
        "--bin",
        "happy-sandbox-setup",
        ...(profile === "release" ? ["--release"] : []),
    ],
    {
        cwd: cargoRoot,
        env: {
            ...process.env,
            CARGO_PROFILE_DEV_DEBUG: "0",
            CARGO_PROFILE_RELEASE_DEBUG: "0",
            CARGO_PROFILE_RELEASE_STRIP: "symbols",
        },
    },
);
const output = join(cargoRoot, "target", profile);
const destination = join(packageRoot, "native/target", profile);
mkdirSync(destination, { recursive: true });
for (const name of [
    "happy-agent-supervisor.exe",
    "happy-sandbox-runner.exe",
    "happy-sandbox-setup.exe",
]) {
    if (!existsSync(join(output, name))) throw new Error(`Missing build output: ${name}`);
    copyFileSync(join(output, name), join(destination, name));
}
console.log(`Built native Happy sandbox and both helpers in ${destination}`);
console.log(
    "Building does not run sandbox provisioning. Sign the three helpers before embedding them in a release executable.",
);
