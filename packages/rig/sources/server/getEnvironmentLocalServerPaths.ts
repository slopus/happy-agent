import { isAbsolute, join, resolve } from "node:path";

import { getDefaultAgentDatabasePath } from "./getDefaultAgentDatabasePath.js";
import { getLocalServerPaths, type LocalServerPaths } from "./LocalServerPaths.js";

export function getEnvironmentLocalServerPaths(
    environment: NodeJS.ProcessEnv = process.env,
    uid = process.getuid?.() ?? 0,
): LocalServerPaths {
    const configuredDirectory = environment.RIG_SERVER_DIRECTORY?.trim();
    const directory =
        configuredDirectory === undefined || configuredDirectory.length === 0
            ? undefined
            : isAbsolute(configuredDirectory)
              ? configuredDirectory
              : resolve(configuredDirectory);
    const paths =
        directory === undefined
            ? getLocalServerPaths(uid, {
                  databasePath: getDefaultAgentDatabasePath(environment),
              })
            : getLocalServerPaths(uid, {
                  databasePath: join(directory, "agent-sessions.sqlite"),
                  directory,
              });
    return {
        ...paths,
        socketPath: environment.RIG_SERVER_SOCKET_PATH?.trim() || paths.socketPath,
        tokenPath: environment.RIG_SERVER_TOKEN_PATH?.trim() || paths.tokenPath,
    };
}
