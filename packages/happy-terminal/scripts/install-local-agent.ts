import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, link, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    isExecutableFile,
    writeHappyAgentBinaryConfig,
} from "../sources/daemon/happyAgentBinaryConfig.js";
import { acquireHappyAgentInstallLock } from "../sources/daemon/ensureHappyAgentBinary.js";
import {
    getHappyDaemonPaths,
    happyAgentBinaryPath,
} from "../sources/daemon/getHappyDaemonPaths.js";

const LOCAL_AGENT_VERSION = "0.0.0";
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = dirname(dirname(packageRoot));
const target = `${process.platform}-${process.arch}`;
const sourcePath = join(
    workspaceRoot,
    "packages",
    "happy-agent",
    "dist",
    "bin",
    `happy-agent-${target}`,
);
if (!(await isExecutableFile(sourcePath))) {
    throw new Error(`The local Happy Agent binary is missing or not executable: ${sourcePath}`);
}

const paths = getHappyDaemonPaths(process.env);
const versionDirectory = join(paths.versionsDirectory, LOCAL_AGENT_VERSION);
const targetPath = happyAgentBinaryPath(paths, LOCAL_AGENT_VERSION);
const temporaryPath = join(versionDirectory, `.happy-agent.${process.pid}.${randomUUID()}.tmp`);

await mkdir(paths.distDirectory, { mode: 0o700, recursive: true });
await chmod(paths.distDirectory, 0o700);
await mkdir(paths.versionsDirectory, { mode: 0o700, recursive: true });
await chmod(paths.versionsDirectory, 0o700);
await mkdir(versionDirectory, { mode: 0o700, recursive: true });
await chmod(versionDirectory, 0o700);
await rm(temporaryPath, { force: true });

const installLock = await acquireHappyAgentInstallLock(paths.installLockPath, (message) =>
    console.log(message),
);
try {
    try {
        // A hard link avoids duplicating a roughly 400 MB local binary while
        // remaining a regular file to Happy Terminal and Happy Desktop. Their managed
        // binary checks intentionally reject symlinks.
        await link(sourcePath, temporaryPath);
    } catch (error) {
        if (!errorCodeIs(error, "EXDEV")) throw error;
        await copyFile(sourcePath, temporaryPath);
    }
    await chmod(temporaryPath, 0o700);
    await rename(temporaryPath, targetPath);
    await writeHappyAgentBinaryConfig(paths, LOCAL_AGENT_VERSION);
} finally {
    await rm(temporaryPath, { force: true });
    await installLock.release();
}

console.log(`Installed local Happy Agent ${LOCAL_AGENT_VERSION} at ${targetPath}`);
console.log(`Happy Agent socket: ${paths.socketPath}`);

if (process.argv.includes("--reload")) {
    await runBinary(targetPath, paths.happyHome);
    console.log(`Reloaded the daemon from ${targetPath}`);
}

function errorCodeIs(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}

function runBinary(path: string, happyHome: string): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(
            path,
            ["reload"],
            { env: { ...process.env, HAPPY_HOME_DIR: happyHome } },
            (error) => {
                if (error === null) resolve();
                else reject(error);
            },
        );
    });
}
