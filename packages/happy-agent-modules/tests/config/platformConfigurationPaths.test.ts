import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";

const roots: string[] = [];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(async () => {
    Object.defineProperty(process, "platform", platformDescriptor);
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each([
    ["linux", "happy", "config"],
    ["darwin", "Happy", "Config"],
] as const)(
    "loads and initializes the %s configuration directory",
    async (platform, publicName, configName) => {
        Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
        const root = await mkdtemp(join(tmpdir(), "happy-platform-config-"));
        roots.push(root);
        const configHome = join(root, publicName, configName);
        await mkdir(configHome, { recursive: true });
        const token = "t".repeat(43);
        const source = `[api]\ntoken = "${token}"\n[feature.tailcat]\nenabled = true\n`;
        await writeFile(join(configHome, "happy.toml"), source);

        const config = await ConfigModule.load(join(root, ".happy"));
        expect(config.configuration.paths).toMatchObject({
            publicHome: join(root, publicName),
            configHome,
            globalConfigPath: join(configHome, "happy.toml"),
            mcpConfigPath: join(configHome, "mcp.toml"),
            instructionsPath: join(configHome, "AGENTS.md"),
            securityPath: join(configHome, "SECURITY.md"),
            runtimeConfigPath: join(root, ".happy", "agent", "runtime.toml"),
        });
        expect(config.configuration.values.api?.token).toBe(token);
        expect(config.tailcatEnabled).toBe(true);

        await config.ensureUserConfigurationFiles();
        expect(await readFile(join(configHome, "happy.toml"), "utf8")).toBe(source);
        expect((await readdir(root)).sort()).toEqual([publicName]);
        expect((await readdir(configHome)).sort()).toEqual([
            "AGENTS.md",
            "SECURITY.md",
            "happy.toml",
            "mcp.toml",
        ]);
    },
);
