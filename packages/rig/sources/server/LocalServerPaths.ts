import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { getDefaultAgentDatabasePath } from "./getDefaultAgentDatabasePath.js";

export interface LocalServerPaths {
    databasePath: string;
    diagnosticsPath: string;
    directory: string;
    irohSecretKeyPath: string;
    logPath: string;
    p2pIdentityPath: string;
    registryPath: string;
    socketPath: string;
    tokenPath: string;
}

export interface GetLocalServerPathsOptions {
    databasePath?: string;
    directory?: string;
}

export function getLocalServerPaths(
    uid = process.getuid?.() ?? 0,
    options: GetLocalServerPathsOptions = {},
): LocalServerPaths {
    const directory = options.directory ?? join(tmpdir(), `rig-${uid}`);
    const databasePath = options.databasePath ?? getDefaultAgentDatabasePath();
    return {
        databasePath,
        diagnosticsPath: join(directory, "diagnostics"),
        directory,
        irohSecretKeyPath: join(dirname(databasePath), "iroh-secret-key"),
        logPath: join(directory, "server.log"),
        p2pIdentityPath: join(dirname(databasePath), "p2p-instance-identity.json"),
        registryPath: join(directory, "server.json"),
        socketPath: join(directory, "server.sock"),
        tokenPath: join(directory, "token"),
    };
}
