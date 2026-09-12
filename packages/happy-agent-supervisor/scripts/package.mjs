import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
    chmodSync,
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceManifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const targets = {
    "x86_64-pc-windows-gnu": {
        alias: "@slopus/happy-agent-supervisor-win32-x64",
        cpu: "x64",
        os: "win32",
        tag: "win32-x64",
    },
    "aarch64-apple-darwin": {
        alias: "@slopus/happy-agent-supervisor-darwin-arm64",
        cpu: "arm64",
        os: "darwin",
        tag: "darwin-arm64",
    },
    "x86_64-apple-darwin": {
        alias: "@slopus/happy-agent-supervisor-darwin-x64",
        cpu: "x64",
        os: "darwin",
        tag: "darwin-x64",
    },
    "aarch64-unknown-linux-musl": {
        alias: "@slopus/happy-agent-supervisor-linux-arm64",
        cpu: "arm64",
        os: "linux",
        tag: "linux-arm64",
    },
    "x86_64-unknown-linux-musl": {
        alias: "@slopus/happy-agent-supervisor-linux-x64",
        cpu: "x64",
        os: "linux",
        tag: "linux-x64",
    },
};
const sharedFiles = ["LICENSE", "README.md"];

const [kind, ...rawArgs] = process.argv.slice(2);
const args = parseArgs(rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs);
const version = args.version ?? sourceManifest.version;
const output = path.resolve(args.output ?? path.join(packageRoot, "artifacts"));
mkdirSync(output, { recursive: true });

if (kind === "root") {
    buildRoot(version, output);
} else if (kind === "platform") {
    buildPlatform(version, output, required(args, "target"), required(args, "binary"));
} else {
    throw new Error(
        "Usage: package.mjs root|platform [--version X] [--output DIR] " +
            "[--target TRIPLE --binary PATH]",
    );
}

function buildRoot(releaseVersion, outputDirectory) {
    run("pnpm", ["build"]);
    const stage = createStage("root");
    try {
        cpSync(path.join(packageRoot, "dist"), path.join(stage, "dist"), { recursive: true });
        copySharedFiles(stage);
        const optionalDependencies = Object.values(targets).reduce((dependencies, target) => {
            dependencies[target.alias] =
                `npm:${sourceManifest.name}@${releaseVersion}-${target.tag}`;
            return dependencies;
        }, {});
        writeManifest(stage, {
            ...publishableManifest(releaseVersion),
            files: ["dist", ...sharedFiles],
            optionalDependencies,
        });
        pack(stage, outputDirectory);
    } finally {
        rmSync(stage, { force: true, recursive: true });
    }
}

function buildPlatform(releaseVersion, outputDirectory, targetName, binaryName) {
    const target = targets[targetName];
    if (target === undefined) throw new Error(`Unsupported target: ${targetName}`);
    const binary = path.resolve(binaryName);
    if (!existsSync(binary)) throw new Error(`Native binary does not exist: ${binary}`);
    const stage = createStage(target.tag);
    try {
        copySharedFiles(stage);
        const executableName =
            target.os === "win32" ? "happy-agent-supervisor.exe" : "happy-agent-supervisor";
        const executable = path.join(stage, "vendor", targetName, "bin", executableName);
        mkdirSync(path.dirname(executable), { recursive: true });
        copyFileSync(binary, executable);
        chmodSync(executable, 0o755);
        const packagedFiles = [executableName];
        if (target.os === "win32") {
            for (const helper of ["happy-sandbox-runner.exe", "happy-sandbox-setup.exe"]) {
                copyFileSync(
                    path.join(path.dirname(binary), helper),
                    path.join(path.dirname(executable), helper),
                );
                packagedFiles.push(helper);
            }
            for (const license of ["LICENSE.codex", "NOTICE.codex"]) {
                copyFileSync(
                    path.join(packageRoot, "native", "windows", license),
                    path.join(path.dirname(executable), license),
                );
                packagedFiles.push(license);
            }
        }
        writeFileSync(
            path.join(stage, "SHA256SUMS"),
            packagedFiles
                .map(
                    (name) =>
                        `${createHash("sha256")
                            .update(readFileSync(path.join(path.dirname(executable), name)))
                            .digest("hex")}  vendor/${targetName}/bin/${name}\n`,
                )
                .join(""),
        );
        writeManifest(stage, {
            name: sourceManifest.name,
            version: `${releaseVersion}-${target.tag}`,
            description: `${sourceManifest.description} Native binary for ${target.tag}.`,
            license: sourceManifest.license,
            repository: sourceManifest.repository,
            engines: sourceManifest.engines,
            os: [target.os],
            cpu: [target.cpu],
            bin: {
                "happy-agent-supervisor": `vendor/${targetName}/bin/${executableName}`,
            },
            files: ["vendor", "SHA256SUMS", ...sharedFiles],
            publishConfig: { access: "public", tag: "platform" },
        });
        pack(stage, outputDirectory);
    } finally {
        rmSync(stage, { force: true, recursive: true });
    }
}

function copySharedFiles(stage) {
    for (const file of sharedFiles) {
        const source = path.join(packageRoot, file);
        if (!existsSync(source)) throw new Error(`Required package file does not exist: ${source}`);
        copyFileSync(source, path.join(stage, file));
    }
}

function createStage(label) {
    return mkdtempSync(path.join(tmpdir(), `happy-agent-supervisor-${label}-`));
}

function pack(stage, outputDirectory) {
    run("pnpm", ["pack", "--pack-destination", outputDirectory], stage);
}

function parseArgs(values) {
    const parsed = {};
    for (let index = 0; index < values.length; index += 2) {
        const key = values[index];
        const value = values[index + 1];
        if (key === undefined || !key.startsWith("--") || value === undefined) {
            throw new Error(`Invalid package argument near ${String(key)}.`);
        }
        parsed[key.slice(2)] = value;
    }
    return parsed;
}

function publishableManifest(releaseVersion) {
    const { devDependencies: _devDependencies, scripts: _scripts, ...manifest } = sourceManifest;
    return { ...manifest, version: releaseVersion };
}

function required(values, key) {
    const value = values[key];
    if (value === undefined) throw new Error(`Missing --${key}.`);
    return value;
}

function run(command, commandArguments, cwd = packageRoot) {
    if (process.platform === "win32" && command === "pnpm") {
        if (!process.env.npm_execpath) throw new Error("Run package scripts through pnpm.");
        commandArguments = [process.env.npm_execpath, ...commandArguments];
        command = process.execPath;
    }
    const result = spawnSync(command, commandArguments, {
        cwd,
        encoding: "utf8",
        stdio: "inherit",
    });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
        throw new Error(
            `${command} ${commandArguments.join(" ")} exited with ${String(result.status)}.`,
        );
    }
}

function writeManifest(stage, manifest) {
    writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}
