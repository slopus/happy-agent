import { mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const args = process.argv.slice(2);
const operation = args.shift();
const options = {};
while (args.length) {
    const key = args.shift();
    if (!["--version", "--target", "--binary", "--output"].includes(key) || !args.length)
        throw new Error(`Invalid package argument: ${key}`);
    options[key.slice(2)] = args.shift();
}
const version = options.version;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-preview\.(0|[1-9]\d*))?$/.test(version ?? ""))
    throw new Error("Select a semantic package version with --version.");
const output = resolve(options.output ?? join(root, "artifacts/npm"));
const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"];
const platform = targets.find((target) => target === options.target);
const manifest = {
    name: operation === "platform" ? `@slopus/happy-agent-${platform}` : "@slopus/happy-agent",
    version,
    license: "MIT",
    description:
        "Happy Agent Rust provider and durable agent runtime (product daemon migration is incomplete).",
    repository: { type: "git", url: "git+https://github.com/slopus/happy-agent.git" },
};
const packageRoot = join(output, operation === "platform" ? (platform ?? "invalid") : "root");
mkdirSync(packageRoot, { recursive: true });
if (operation === "platform") {
    if (!platform || !options.binary)
        throw new Error("Platform packaging requires --target and --binary.");
    const [os, cpu] = platform.split("-");
    manifest.os = [os];
    manifest.cpu = [cpu];
    manifest.files = ["bin", "README.md", "LICENSE"];
    manifest.publishConfig = {
        executableFiles: [`bin/happy-agent${os === "win32" ? ".exe" : ""}`],
    };
    mkdirSync(join(packageRoot, "bin"), { recursive: true });
    const binary = join(packageRoot, "bin", os === "win32" ? "happy-agent.exe" : "happy-agent");
    copyFileSync(resolve(options.binary), binary);
    if (os !== "win32") chmodSync(binary, 0o755);
} else if (operation === "root") {
    manifest.bin = { "happy-agent": "bin/happy-agent.cjs" };
    manifest.files = ["bin", "README.md", "LICENSE"];
    manifest.engines = { node: ">=22" };
    manifest.optionalDependencies = Object.fromEntries(
        targets.map((target) => [`@slopus/happy-agent-${target}`, version]),
    );
    mkdirSync(join(packageRoot, "bin"), { recursive: true });
    copyFileSync(
        join(root, "packages/happy-agent/bin/happy-agent.cjs"),
        join(packageRoot, "bin/happy-agent.cjs"),
    );
} else throw new Error("Use platform or root as the package operation.");
copyFileSync(join(root, "LICENSE"), join(packageRoot, "LICENSE"));
writeFileSync(
    join(packageRoot, "README.md"),
    readFileSync(join(root, "packages/happy-agent/RUST.md")),
);
writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
mkdirSync(output, { recursive: true });
const result = spawnSync("pnpm", ["pack", "--pack-destination", output], {
    cwd: packageRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
