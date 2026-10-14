import { homedir } from "node:os";
import { isAbsolute, normalize, relative, resolve } from "node:path";

import type { ComputeHostPolicy } from "../../ComputeHostPolicy.js";
import { createHostPolicyPrivatePaths } from "../../sandbox/impl/createHostPolicyPrivatePaths.js";
import { createSensitiveReadPaths } from "../../sandbox/impl/createSensitiveReadPaths.js";

/**
 * The private and credential paths a restricted host command must not read, for one workspace.
 *
 * Every restricted host command shares this one computation, so a long-lived command worker and
 * a one-off shell command cannot drift into different read boundaries.
 */
export function resolveHostDeniedReadPaths(options: {
    canonicalCwd: string;
    canonicalHome: string;
    environment: NodeJS.ProcessEnv | undefined;
    homeDirectory: string | undefined;
    hostPolicy: ComputeHostPolicy | undefined;
}): { privatePaths: string[]; sensitiveReadPaths: string[] } {
    const privatePaths = absoluteHostPaths(
        options.canonicalCwd,
        createHostPolicyPrivatePaths(options.hostPolicy, options.environment),
    );
    const sensitiveReadPaths = absoluteHostPaths(
        options.canonicalCwd,
        createSensitiveReadPaths({
            ...(options.environment === undefined ? {} : { environment: options.environment }),
            ...(options.homeDirectory === undefined
                ? {}
                : { homeDirectory: options.homeDirectory }),
            ...(options.hostPolicy === undefined ? {} : { hostPolicy: options.hostPolicy }),
        }),
    ).filter((path) =>
        shouldDenySensitiveReadPath(path, options.canonicalCwd, options.canonicalHome),
    );
    return { privatePaths, sensitiveReadPaths };
}

export function defaultHomeDirectory(homeDirectory: string | undefined): string {
    return homeDirectory ?? homedir();
}

export function absoluteHostPaths(cwd: string, paths: readonly string[]): string[] {
    return [
        ...new Set(paths.map((path) => (isAbsolute(path) ? normalize(path) : resolve(cwd, path)))),
    ];
}

function shouldDenySensitiveReadPath(path: string, cwd: string, homeDirectory: string): boolean {
    const normalizedPath = normalize(path);
    const normalizedHome = normalize(homeDirectory);
    if (normalizedPath !== normalizedHome) return true;
    const normalizedCwd = normalize(cwd);
    // The package protects the home tree by default, but an ordinary workspace usually lives
    // below it. Masking the whole home tree in that case would also mask the workspace. Keep all
    // narrower credential paths in the policy, and only omit the broad home root for a strict
    // descendant workspace; a workspace equal to or above home remains protected.
    return !(normalizedCwd !== normalizedHome && isPathInside(normalizedHome, normalizedCwd));
}

function isPathInside(root: string, target: string): boolean {
    const relativePath = relative(root, target);
    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
