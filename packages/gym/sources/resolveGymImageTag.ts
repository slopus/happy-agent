import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { formatGymImageTag } from "./formatGymImageTag.js";

const resolvedTags = new Map<string, Promise<string>>();

export function resolveGymImageTag(repositoryRoot: string): Promise<string> {
    const configuredImage = process.env.HAPPY_TERMINAL_GYM_IMAGE;
    if (configuredImage !== undefined) return Promise.resolve(configuredImage);

    let tag = resolvedTags.get(repositoryRoot);
    if (tag === undefined) {
        tag = fingerprintGymRuntime(repositoryRoot).then(formatGymImageTag);
        resolvedTags.set(repositoryRoot, tag);
    }
    return tag;
}

async function fingerprintGymRuntime(repositoryRoot: string): Promise<string> {
    const paths = [
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "tsconfig.json",
        "tsconfig.base.json",
        "packages/gym/Dockerfile",
    ].map((path) => join(repositoryRoot, path));
    const hash = createHash("sha256");
    for (const path of paths) {
        hash.update(relative(repositoryRoot, path));
        hash.update("\0");
        hash.update(await readFile(path));
        hash.update("\0");
    }
    for (const [path, select] of [
        [
            "package.json",
            (manifest: PackageManifest) => ({ packageManager: manifest.packageManager }),
        ],
        [
            "packages/gym-tests/package.json",
            (manifest: PackageManifest) => ({
                dependencies: manifest.dependencies,
                name: manifest.name,
            }),
        ],
        [
            "packages/happy-terminal/package.json",
            (manifest: PackageManifest) => ({
                bin: manifest.bin,
                name: manifest.name,
                scripts: { build: manifest.scripts?.build },
                type: manifest.type,
            }),
        ],
    ] as const) {
        hash.update(path);
        hash.update("\0");
        const manifest = JSON.parse(
            await readFile(join(repositoryRoot, path), "utf8"),
        ) as PackageManifest;
        hash.update(JSON.stringify(select(manifest)));
        hash.update("\0");
    }
    return hash.digest("hex");
}

interface PackageManifest {
    bin?: unknown;
    dependencies?: unknown;
    name?: unknown;
    packageManager?: unknown;
    scripts?: Record<string, unknown>;
    type?: unknown;
}
