import { join } from "node:path";

export function getDefaultLocalConfigPath(cwd: string = process.cwd()): string {
    return join(cwd, "happy.toml");
}
