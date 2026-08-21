import type { PartialConfigDefaults } from "./types.js";
import { writeRuntimeConfig } from "./writeRuntimeConfig.js";

export async function writeRuntimeConfigDefaults(
    path: string,
    defaults: PartialConfigDefaults,
): Promise<void> {
    await writeRuntimeConfig(path, { defaults });
}
