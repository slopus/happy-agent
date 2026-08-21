import { join } from "node:path";

import { getHappyConfigDirectory } from "./getHappyConfigDirectory.js";

export function getDefaultGlobalConfigPath(
    env: NodeJS.ProcessEnv = process.env,
    homeDirectory?: string,
): string {
    return join(getHappyConfigDirectory(env, homeDirectory), "happy.toml");
}
