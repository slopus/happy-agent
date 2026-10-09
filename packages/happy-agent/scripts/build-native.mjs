import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const targets = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-arm64": "aarch64-unknown-linux-musl",
    "linux-x64": "x86_64-unknown-linux-musl",
    "win32-x64": "x86_64-pc-windows-msvc",
};
const args = process.argv.slice(2);
let target = `${process.platform}-${process.arch}`;
let debug = false;
for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") continue;
    else if (args[i] === "--target") target = args[++i];
    else if (args[i] === "--debug-host") debug = true;
    else throw new Error(`Unknown build argument: ${args[i]}`);
}
const triple = targets[target];
if (!triple) throw new Error(`The native release does not support ${target}.`);
const command = ["build", "--locked", "--package", "happy-agent"];
if (!debug) command.push("--release", "--target", triple);
const env = { ...process.env };
if (!debug && target.startsWith("linux-")) {
    env[`CARGO_TARGET_${triple.toUpperCase().replaceAll("-", "_")}_LINKER`] = "musl-gcc";
    env.CC = "musl-gcc";
}
if (!debug && target.startsWith("win32-"))
    env.RUSTFLAGS = `${env.RUSTFLAGS ?? ""} -C target-feature=+crt-static`.trim();
const result = spawnSync("cargo", command, { cwd: root, env, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const extension = target.startsWith("win32-") ? ".exe" : "";
const directory = process.env.CARGO_TARGET_DIR
    ? resolve(root, process.env.CARGO_TARGET_DIR)
    : join(root, "target");
const source = debug
    ? join(directory, "debug", `happy-agent${extension}`)
    : join(directory, triple, "release", `happy-agent${extension}`);
if (!debug && target.startsWith("linux-")) {
    const headers = spawnSync("readelf", ["-l", source], { encoding: "utf8" });
    if (headers.error || headers.status !== 0 || headers.stdout.includes("INTERP"))
        throw new Error(
            "The Linux release must be a verified static musl executable without an ELF interpreter.",
        );
}
const output = join(root, "packages/happy-agent/dist/bin", `happy-agent-${target}${extension}`);
mkdirSync(join(root, "packages/happy-agent/dist/bin"), { recursive: true });
copyFileSync(source, output);
if (!extension) chmodSync(output, 0o755);
console.log(
    `Built ${output}${debug ? " (host development build; static linkage was not checked)" : ""}`,
);
