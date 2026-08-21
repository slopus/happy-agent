import { readFile } from "node:fs/promises";

import { parseConfigTomlWithUnknownSettings } from "./parseConfigToml.js";
import type { ConfigSource } from "./types.js";

export async function readConfigFile(path: string): Promise<ConfigSource> {
    try {
        const source = await readFile(path, "utf8");
        const parsed = parseConfigTomlWithUnknownSettings(source);
        return {
            exists: true,
            path,
            unknownSettings: parsed.unknownSettings,
            values: parsed.values,
        };
    } catch (error) {
        if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (error.code === "ENOENT" || error.code === "ENOTDIR")
        ) {
            return {
                exists: false,
                path,
                unknownSettings: [],
                values: {},
            };
        }
        throw error;
    }
}
