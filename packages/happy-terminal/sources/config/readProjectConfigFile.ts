import { readConfigFile } from "./readConfigFile.js";
import type { ConfigSource } from "./types.js";

export async function readProjectConfigFile(happyTomlPath: string): Promise<ConfigSource> {
    return readConfigFile(happyTomlPath);
}
