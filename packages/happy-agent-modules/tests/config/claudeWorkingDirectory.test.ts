import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AnthropicProvider } from "@slopus/happy-providers";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("Claude working directory configuration", () => {
    // Claude Code reads the directory it starts in. A daemon launched from Finder starts in `/`,
    // so leaving Claude Code there had it read other applications' data and prompt for access.
    it("runs Claude Code in an empty private folder under the Happy home", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-claude-cwd-"));
        temporaryDirectories.push(root);
        const configHome = join(
            root,
            process.platform === "darwin" ? "Happy/Config" : "happy/config",
        );
        await mkdir(configHome, { recursive: true });
        await writeFile(
            join(configHome, "happy.toml"),
            [
                "[providers]",
                "default_enable = false",
                "",
                "[providers.claude]",
                "enabled = true",
                "credential_isolation = true",
                'api_key = "test-key"',
            ].join("\n"),
        );
        const directory = join(root, ".happy", "agent", "claude-cwd");

        const config = await ConfigModule.load(join(root, ".happy"));
        const provider = await config.providers.resolve("claude", "anthropic/sonnet-5");

        expect(provider).toBeInstanceOf(AnthropicProvider);
        if (!(provider instanceof AnthropicProvider)) {
            throw new Error("Expected a Claude provider.");
        }
        const session = await provider.session("claude-working-directory", {
            instructions: "",
            tools: [],
        });
        try {
            expect(session).toHaveProperty("cwd", directory);
        } finally {
            await session.destroy();
        }
        expect((await stat(directory)).isDirectory()).toBe(true);
        expect(await readdir(directory)).toEqual([]);
        if (process.platform !== "win32") {
            expect((await stat(directory)).mode & 0o777).toBe(0o700);
        }
    });
});
