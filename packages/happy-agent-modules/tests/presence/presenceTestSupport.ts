import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ConfigModule } from "../../sources/config/index.js";

/**
 * A configuration loaded from settings written on disk, exactly as the person's own would be.
 *
 * Presence reads its catalog and its starting state from the configuration, so a test that wants
 * a custom state writes the same `happy.toml` a person would write instead of handing the module
 * a catalog it would never receive in production.
 */
export async function presenceConfig(toml: string): Promise<ConfigModule> {
    const home = await mkdtemp(join(tmpdir(), "happy-presence-"));
    const happyHome = join(home, ".happy");
    const globalConfigPath = join(
        home,
        process.platform === "darwin" ? "Happy/Config" : "happy/config",
        "happy.toml",
    );
    await mkdir(dirname(globalConfigPath), { recursive: true });
    await writeFile(globalConfigPath, toml, "utf8");
    return await ConfigModule.load(happyHome);
}
