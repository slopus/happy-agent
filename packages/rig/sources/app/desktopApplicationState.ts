import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, readFile, readlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { RigUserError } from "../RigUserError.js";
import { HAPPY_DESKTOP_PACKAGE } from "./desktopApplicationBuild.js";
import { desktopApplicationName, desktopLocalWebOrigin } from "./desktopApplicationRuntime.js";

const desktopBuildStampSchema = Type.Object(
    {
        builtAt: Type.String(),
        contentHash: Type.String({ minLength: 1 }),
        happy2Root: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
);
export type DesktopBuildStamp = Static<typeof desktopBuildStampSchema>;

export async function desktopApplicationContentHash(
    rigRoot: string,
    happy2Root: string,
): Promise<string> {
    const hash = createHash("sha256");
    hash.update(`desktop-v1\0${desktopLocalWebOrigin}\0${process.platform}\0${process.arch}\0`);
    await repositoryFilesHash(hash, rigRoot, [
        "package.json",
        "pnpm-lock.yaml",
        "packages/rig/package.json",
        "packages/rig/scripts",
        "packages/rig/sources",
        "packages/rig-execution/package.json",
        "packages/rig-execution/sources",
        "packages/rig-providers/package.json",
        "packages/rig-providers/sources",
        "packages/rig-codemode-codex/package.json",
        "packages/rig-codemode-codex/sources",
        "packages/happy-plugins/package.json",
        "packages/happy-plugins/sources",
    ]);
    await repositoryFilesHash(hash, happy2Root, [
        "package.json",
        "pnpm-lock.yaml",
        "scripts/create-mac-icon.mjs",
        `packages/${HAPPY_DESKTOP_PACKAGE}`,
    ]);
    return hash.digest("hex");
}

export async function desktopBuildStampRead(path: string): Promise<DesktopBuildStamp | undefined> {
    try {
        const value = JSON.parse(await readFile(path, "utf8")) as unknown;
        return Value.Check(desktopBuildStampSchema, value) ? value : undefined;
    } catch {
        return undefined;
    }
}

export async function desktopBuildStampWrite(
    path: string,
    stamp: DesktopBuildStamp,
): Promise<void> {
    await writeFile(path, `${JSON.stringify(stamp, null, 4)}\n`);
}

export async function desktopApplicationResolve(
    releaseDirectory: string,
): Promise<string | undefined> {
    const architectureDirectory = process.arch === "arm64" ? "mac-arm64" : "mac";
    const candidates = [
        join(releaseDirectory, architectureDirectory, `${desktopApplicationName}.app`),
        join(releaseDirectory, "mac", `${desktopApplicationName}.app`),
        join(releaseDirectory, "mac-arm64", `${desktopApplicationName}.app`),
    ];
    for (const candidate of candidates) {
        const contents = join(candidate, "Contents");
        const requiredPaths = [
            join(contents, "MacOS", desktopApplicationName),
            join(contents, "Resources", "app.asar"),
            join(contents, "Resources", "rig-runtime", "bin", "rig"),
            join(contents, "Resources", "rig-runtime", "dist", "main.js"),
            join(contents, "Resources", "rig-runtime", "node_modules"),
        ];
        if ((await Promise.all(requiredPaths.map(pathExists))).every(Boolean)) {
            return candidate;
        }
    }
    return undefined;
}

export async function rigRepositoryRootResolve(): Promise<string> {
    const configured = process.env.RIG_SOURCE_DIRECTORY?.trim();
    const starts = [
        ...(configured ? [configured] : []),
        ...(process.argv[1] ? [dirname(resolve(process.argv[1]))] : []),
        process.cwd(),
    ];
    for (const start of starts) {
        const root = await ancestorFind(start, "pnpm-workspace.yaml");
        if (root && (await pathExists(join(root, "packages", "rig", "package.json")))) return root;
    }
    throw new RigUserError("Rig desktop needs the Rig source checkout that built this command.", {
        hint: "Run the checkout's built CLI, or set RIG_SOURCE_DIRECTORY to the Rig repository.",
    });
}

export async function happy2RepositoryRootResolve(
    configured: string | undefined,
    rigRoot: string,
): Promise<string> {
    const environment = process.env.HAPPY2_SOURCE_DIRECTORY?.trim();
    const candidates = [
        ...(configured ? [configured] : []),
        ...(environment ? [environment] : []),
        resolve(rigRoot, "..", "happy-desktop"),
        resolve(rigRoot, "..", "..", "happy-desktop"),
        join(homedir(), "projects", "happy-desktop"),
        join(homedir(), "Developer", "happy-desktop"),
    ];
    for (const candidate of candidates) {
        const root = resolve(candidate);
        if (
            (await pathExists(join(root, "package.json"))) &&
            (await pathExists(join(root, "packages", HAPPY_DESKTOP_PACKAGE, "package.json")))
        ) {
            return root;
        }
    }
    throw new RigUserError("Rig could not find a local Happy 2 source checkout.", {
        hint: "Run rig desktop --happy2-root /path/to/happy2.",
    });
}

async function repositoryFilesHash(
    hash: ReturnType<typeof createHash>,
    root: string,
    paths: readonly string[],
): Promise<void> {
    const listed = await commandCapture(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...paths],
        root,
    );
    const files = listed.toString("utf8").split("\0").filter(Boolean).sort();
    for (const file of files) {
        const path = join(root, file);
        hash.update(relative(root, path));
        hash.update("\0");
        // A symlink's content is where it points, and reading through it is wrong twice over: the
        // app ships links into a packaged layout that does not exist in a source checkout, so
        // following them fails outright, and a link that did resolve would hash its target's bytes
        // and miss the retarget that is the only change a symlink can have.
        const stats = await lstat(path);
        hash.update(stats.isSymbolicLink() ? await readlink(path) : await readFile(path));
        hash.update("\0");
    }
}

async function ancestorFind(start: string, marker: string): Promise<string | undefined> {
    let current = resolve(start);
    for (;;) {
        if (await pathExists(join(current, marker))) return current;
        const parent = dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

function commandCapture(
    command: string,
    arguments_: readonly string[],
    cwd: string,
): Promise<Buffer> {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(command, [...arguments_], {
            cwd,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const output: Buffer[] = [];
        const errors: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (code === 0) resolvePromise(Buffer.concat(output));
            else {
                const detail = Buffer.concat(errors).toString("utf8").trim();
                reject(
                    new RigUserError(
                        `${command} failed${signal ? ` with ${signal}` : ` with exit code ${code ?? 1}`}${detail ? `: ${detail}` : "."}`,
                    ),
                );
            }
        });
    });
}
