import { posix, win32 } from "node:path";

import {
    parseSupervisorPolicy,
    type SupervisorNetworkPolicy,
    type SupervisorPolicy,
} from "@slopus/happy-agent-supervisor";

import type { ComputeNetworkPermissions, ComputePermissions } from "../ComputePermissions.js";

/**
 * Builds the native supervisor document from one immutable compute permission value.
 *
 * The supervisor deliberately owns the final validation. Keeping this translation small means
 * host and Docker commands cannot quietly grow different interpretations of the same permission
 * value.
 */
export function createSupervisorPolicy(options: {
    cwd: string;
    /** Platform where permission paths are interpreted. */
    platform?: NodeJS.Platform;
    permissions: ComputePermissions;
    allowedReadPaths?: readonly string[];
    deniedReadPaths?: readonly string[];
    allowedWritePaths?: readonly string[];
    deniedWritePaths?: readonly string[];
    deniedWriteFilePaths?: readonly string[];
    network?: ComputeNetworkPermissions;
    /** Forces a proxy even for an empty host list, which means "deny every destination". */
    networkProxy?: boolean;
}): SupervisorPolicy {
    const paths = (options.platform ?? process.platform) === "win32" ? win32 : posix;
    const absolutePaths = (values: readonly string[]): string[] => [
        ...new Set(
            values.map((path) =>
                paths.isAbsolute(path) ? paths.normalize(path) : paths.resolve(options.cwd, path),
            ),
        ),
    ];
    const network = options.network ?? options.permissions.network;
    const allowedHosts = [...(network.allowedHosts ?? [])];
    if (allowedHosts.includes("*")) {
        throw new Error(
            "Network allowedHosts cannot contain a bare '*'; leave allowedHosts empty for open egress.",
        );
    }
    const allowedReadPaths = options.allowedReadPaths ?? options.permissions.allowedReadPaths;
    const deniedReadPaths = options.deniedReadPaths ?? options.permissions.deniedReadPaths;
    const allowedWritePaths =
        options.permissions.mode === "read_only"
            ? undefined
            : (options.allowedWritePaths ?? options.permissions.allowedWritePaths);
    const deniedWritePaths = options.deniedWritePaths ?? options.permissions.deniedWritePaths;
    const nativeNetwork: SupervisorNetworkPolicy = {
        egress: network.egress,
        localBinding: network.localBinding,
        ...(allowedHosts.length === 0 ? {} : { allowedHosts }),
        ...(network.egress && (options.networkProxy === true || allowedHosts.length > 0)
            ? { outgoingProxy: { frontEnds: ["http", "socks5"] as const } }
            : {}),
    };
    return parseSupervisorPolicy({
        mode: options.permissions.mode,
        ...(allowedReadPaths === undefined
            ? {}
            : { allowedReadPaths: absolutePaths(allowedReadPaths) }),
        ...(deniedReadPaths === undefined
            ? {}
            : { deniedReadPaths: absolutePaths(deniedReadPaths) }),
        ...(allowedWritePaths === undefined
            ? {}
            : { allowedWritePaths: absolutePaths(allowedWritePaths) }),
        ...(deniedWritePaths === undefined
            ? {}
            : { deniedWritePaths: absolutePaths(deniedWritePaths) }),
        ...(options.deniedWriteFilePaths === undefined
            ? {}
            : { deniedWriteFilePaths: absolutePaths(options.deniedWriteFilePaths) }),
        network: nativeNetwork,
    });
}
