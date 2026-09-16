import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ComputeHostPolicy } from "../ComputeHostPolicy.js";
import type { ComputeServiceStartOptions } from "../ComputeServices.js";
import { createSensitiveReadPaths } from "../sandbox/impl/createSensitiveReadPaths.js";
import { projectProtectedFileNames } from "../sandbox/impl/projectProtectedFileNames.js";
import { resolvePotentialPath } from "../sandbox/impl/resolvePotentialPath.js";

export interface ServiceInputEnvironment {
    cwd: string;
    hostPolicy?: ComputeHostPolicy;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
}

/** Resolve selected live inputs; the native supervisor pins these again without following symlinks. */
export async function resolveServiceInputs(
    environment: ServiceInputEnvironment,
    start: ComputeServiceStartOptions,
): Promise<{ source: string; destination: string }[]> {
    const workspace = await realpath(environment.cwd);
    const home = await resolvePotentialPath(environment.homeDirectory ?? homedir());
    const privateDirectories = await Promise.all(
        (environment.hostPolicy?.privateDirectories ?? []).map((path) =>
            resolvePotentialPath(resolve(workspace, path)),
        ),
    );
    const controlDirectory = start.execution.directory;
    if (
        inside(workspace, controlDirectory) ||
        !privateDirectories.some((path) => inside(path, controlDirectory))
    ) {
        throw new Error(
            "Service control storage must be outside the workspace and inside a declared private daemon directory.",
        );
    }
    const sensitivePaths = await Promise.all(
        createSensitiveReadPaths(environment).map((path) =>
            resolvePotentialPath(isAbsolute(path) ? path : resolve(workspace, path)),
        ),
    );
    const protectedPaths = [
        ...sensitivePaths.filter((path) => path !== home),
        ...(await Promise.all(
            [
                join(workspace, ".git"),
                ...projectProtectedFileNames(environment.hostPolicy).map((name) =>
                    join(workspace, name),
                ),
                ...(start.permissions.deniedReadPaths ?? []),
            ].map((path) =>
                resolvePotentialPath(isAbsolute(path) ? path : resolve(workspace, path)),
            ),
        )),
    ];
    const selected = [...new Set(start.sandbox.inputs)].filter(
        (path, _, all) => !all.some((parent) => parent !== path && path.startsWith(`${parent}/`)),
    );
    const inputs: { source: string; destination: string }[] = [];
    for (const destination of selected) {
        const source = resolve(workspace, destination);
        if (!inside(workspace, source) || (await realpath(source)) !== source) {
            throw new Error(
                `Service input '${destination}' must stay inside the workspace without following symlinks.`,
            );
        }
        if (protectedPaths.some((path) => inside(path, source) || inside(source, path))) {
            throw new Error(
                `Service input '${destination}' includes protected control or credential paths.`,
            );
        }
        const metadata = await lstat(source);
        if (!metadata.isFile() && !metadata.isDirectory()) {
            throw new Error(
                `Select a regular file or directory as service input '${destination}'.`,
            );
        }
        inputs.push({ source, destination });
    }
    return inputs;
}

function inside(parent: string, candidate: string): boolean {
    const path = relative(parent, candidate);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}
