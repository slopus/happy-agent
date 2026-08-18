import { join } from "node:path";

import { getDevelopmentBuildId } from "./getDevelopmentBuildId.js";

export async function configureDevelopmentEnvironment(options: {
    environment?: NodeJS.ProcessEnv;
    repositoryRoot: string;
}): Promise<void> {
    const environment = options.environment ?? process.env;
    const developmentDirectory = join(options.repositoryRoot, ".rig-dev");
    // Happy sync runs in development exactly like in the released CLI: without
    // it a rig-dev daemon never registers a Happy machine, so the Happy app
    // cannot create sessions against the checkout — the main thing a Happy
    // integration developer needs. Opt out with RIG_DISABLE_HAPPY_SYNC=1.
    // A terminal opened by Rig may inherit the running daemon's paths. Development must replace
    // those coordinates or it can mistake the global daemon for this checkout's stale daemon and
    // shut it down. The directory derives every daemon-owned path, including the SQLite database.
    environment.RIG_SERVER_DIRECTORY = developmentDirectory;
    delete environment.RIG_SERVER_SOCKET_PATH;
    delete environment.RIG_SERVER_TOKEN_PATH;
    environment.RIG_DEVELOPMENT_BUILD_ID ??= await getDevelopmentBuildId(options.repositoryRoot);
}
