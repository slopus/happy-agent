import { join } from "node:path";

import { getHappyTerminalHome } from "./getHappyTerminalHome.js";

export function getDefaultRuntimeConfigPath(
    env: NodeJS.ProcessEnv = process.env,
    homeDirectory?: string,
): string {
    return join(getHappyTerminalHome(env, homeDirectory), "runtime.toml");
}
