import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ConfigModule, type ConfigModuleLoadOptions } from "../../sources/config/index.js";

/**
 * Configuration for a test, rooted in a folder the test owns.
 *
 * Everything a module under test asks configuration for — where managed projects and workspaces
 * live, where the agent keeps its own state, what a workspace folder does by default — is settled
 * here rather than passed to that module. Relocating the two managed roots is the product's own
 * mechanism: `HAPPY_AGENT_PROJECTS_DIRECTORY` and `HAPPY_AGENT_WORKSPACES_DIRECTORY` are what a person sets to keep
 * their checkouts somewhere else. The getters are read once while those variables are set, because
 * configuration settles its layout once per installation and remembers it, and the variables are
 * put back afterwards so the rest of the process is unaffected.
 *
 * `toml` is written to the global configuration file the same way a person's own `happy.toml`
 * would be, so a test that needs a feature turned on turns it on the way the product does.
 * `options` is configuration's own load-time seam, which is where a scripted account belongs.
 */
export async function testConfigRootedAt(
    root: string,
    toml?: string,
    options?: ConfigModuleLoadOptions,
): Promise<ConfigModule> {
    const previousProjects = process.env.HAPPY_AGENT_PROJECTS_DIRECTORY;
    const previousWorkspaces = process.env.HAPPY_AGENT_WORKSPACES_DIRECTORY;
    process.env.HAPPY_AGENT_PROJECTS_DIRECTORY = join(root, "projects");
    process.env.HAPPY_AGENT_WORKSPACES_DIRECTORY = join(root, "workspaces");
    try {
        const happyHome = join(root, "happy");
        if (toml !== undefined) {
            const path = (await ConfigModule.load(happyHome)).configuration.paths.globalConfigPath;
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, toml, "utf8");
        }
        const config = await ConfigModule.load(happyHome, options ?? {});
        void config.projectsHome;
        void config.workspacesHome;
        return config;
    } finally {
        restore("HAPPY_AGENT_PROJECTS_DIRECTORY", previousProjects);
        restore("HAPPY_AGENT_WORKSPACES_DIRECTORY", previousWorkspaces);
    }
}

/** The same, over a temporary folder nobody else is using. */
export async function temporaryTestConfig(
    toml?: string,
    options?: ConfigModuleLoadOptions,
): Promise<ConfigModule> {
    return await testConfigRootedAt(await mkdtemp(join(tmpdir(), "happy-modules-")), toml, options);
}

function restore(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}
